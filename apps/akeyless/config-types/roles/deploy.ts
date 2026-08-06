import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage, boolFlag, compactBody, parseJson, type AkeylessClient } from '../../lib/akeyless'
import { extractRoleSpecs, type RoleSpec, type AssocSpec } from './validate'

export interface LivePathRule {
  path?: string
  type?: string
  capabilities?: string[]
}
export interface LiveRoleAssoc {
  assoc_id?: string
  auth_method_name?: string
  auth_method_sub_claims?: Record<string, string[]>
  sub_claims_case_sensitive?: boolean
}
export interface LiveRole {
  role_name?: string
  comment?: string
  delete_protection?: boolean
  rules?: { path_rules?: LivePathRule[] }
  role_auth_methods_assoc?: LiveRoleAssoc[]
}

export interface RuleRollbackEntry {
  path: string
  ruleType: string
  /** Capabilities before this deploy touched the rule; undefined if the rule did not exist before. */
  priorCapabilities?: string[]
}
export interface AssocRollbackEntry {
  authMethodName: string
  /** The association's id - known for update/delete (we already had it); undefined for a brand-new add. */
  assocId?: string
  /** State before this deploy touched the association; undefined if it did not exist before (a new add). */
  prior?: { subClaims: Record<string, string[]>; caseSensitive: boolean }
}
export interface AccessLevels {
  auditAccess: string
  analyticsAccess: string
  gwAnalyticsAccess: string
  sraReportsAccess: string
  usageReportsAccess: string
  eventCenterAccess: string
  isiAccess: string
  reverseRbacAccess: string
}
export interface RoleRollbackEntry {
  name: string
  existed: boolean
  priorBase?: AccessLevels & { description: string; deleteProtection: boolean }
  rules: RuleRollbackEntry[]
  associations: AssocRollbackEntry[]
}

/**
 * Akeyless has no flat "audit-access"/"analytics-access"/... fields on GET -
 * each is encoded as a special PathRule (type search-rule/reports-rule/
 * gw-reports-rule/sra-reports-rule/usage-reports-rule/event-rule/isi-rule,
 * capability "read", path "/*"=all, "/self"=own, "/scoped"=scoped) except
 * reverse-rbac-rule, whose path IS the value directly ("scoped"/"all", no
 * leading slash). Mirrors the terraform provider's own decode
 * (resource_role.go `setAccessRuleField`/`convertPathName`).
 */
export function extractAccessLevels(pathRules: LivePathRule[]): AccessLevels {
  const levels: AccessLevels = {
    auditAccess: '',
    analyticsAccess: '',
    gwAnalyticsAccess: '',
    sraReportsAccess: '',
    usageReportsAccess: '',
    eventCenterAccess: '',
    isiAccess: '',
    reverseRbacAccess: '',
  }
  const pathToLevel: Record<string, string> = { '/*': 'all', '/self': 'own', '/scoped': 'scoped' }
  for (const rule of pathRules) {
    if (!rule.type || !rule.path) continue
    switch (rule.type) {
      case 'search-rule':
        levels.auditAccess = pathToLevel[rule.path] ?? ''
        break
      case 'reports-rule':
        levels.analyticsAccess = pathToLevel[rule.path] ?? ''
        break
      case 'gw-reports-rule':
        levels.gwAnalyticsAccess = pathToLevel[rule.path] ?? ''
        break
      case 'sra-reports-rule':
        levels.sraReportsAccess = pathToLevel[rule.path] ?? ''
        break
      case 'usage-reports-rule':
        levels.usageReportsAccess = pathToLevel[rule.path] ?? ''
        break
      case 'event-rule':
        levels.eventCenterAccess = pathToLevel[rule.path] ?? ''
        break
      case 'isi-rule':
        levels.isiAccess = pathToLevel[rule.path] ?? ''
        break
      case 'reverse-rbac-rule':
        levels.reverseRbacAccess = rule.path.replace(/^\//, '')
        break
      default:
        break
    }
  }
  return levels
}

/**
 * Deploy Akeyless roles. ONE item = ONE role, matched on NAME:
 *   - GET  /get-role     (404 -> does not exist yet)
 *   - POST /create-role  (base fields + event-forwarders-name, create-only)
 *   - POST /update-role  (base fields via the update-role field set - note
 *     the API's own asymmetry: "event-forwarder-access" is singular here,
 *     vs "event-forwarders-access" (plural) on create-role)
 * then reconciles Rules (additive-only via /set-role-rule) and Auth Method
 * Associations (full replace via /assoc-role-am, /update-assoc,
 * /delete-assoc) - see canvas.yaml header for why each uses a different
 * reconciliation strategy.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: RoleRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const existing = await getRole(client, spec.name)
      const entry: RoleRollbackEntry = { name: spec.name, existed: Boolean(existing), rules: [], associations: [] }

      if (existing) {
        entry.priorBase = {
          description: existing.comment ?? '',
          deleteProtection: Boolean(existing.delete_protection),
          ...extractAccessLevels(existing.rules?.path_rules ?? []),
        }
        const res = await client.request('/update-role', buildUpdateRoleBody(spec))
        if (!res.ok) throw new Error(`Failed to update role "${spec.name}": ${akeylessErrorMessage(res)}`)
      } else {
        const res = await client.request('/create-role', buildCreateRoleBody(spec))
        if (!res.ok) throw new Error(`Failed to create role "${spec.name}": ${akeylessErrorMessage(res)}`)
      }

      const liveRules = existing?.rules?.path_rules ?? []
      entry.rules = await reconcileRules(client, spec, liveRules)

      const liveAssocs = existing?.role_auth_methods_assoc ?? []
      entry.associations = await reconcileAssociations(client, spec, liveAssocs)

      rollbackState.push(entry)
      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} role(s) to Akeyless (${baseUrl}): ${deployed.join(', ')}`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Role deployment failed after ${deployed.length} of ${specs.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, deployedRoles: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers -------------------------------------------------------------------

export async function getRole(client: AkeylessClient, name: string): Promise<LiveRole | null> {
  const res = await client.request('/get-role', { name })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to look up role "${name}": ${akeylessErrorMessage(res)}`)
  return parseJson<LiveRole>(res.body) ?? {}
}

export function buildCreateRoleBody(spec: RoleSpec): Record<string, unknown> {
  return compactBody({
    name: spec.name,
    description: spec.description,
    delete_protection: boolFlag(spec.deleteProtection),
    'audit-access': spec.auditAccess,
    'analytics-access': spec.analyticsAccess,
    'gw-analytics-access': spec.gwAnalyticsAccess,
    'sra-reports-access': spec.sraReportsAccess,
    'usage-reports-access': spec.usageReportsAccess,
    'event-center-access': spec.eventCenterAccess,
    'isi-access': spec.isiAccess,
    'reverse-rbac-access': spec.reverseRbacAccess,
    'event-forwarders-access': spec.eventForwardersAccess,
    'event-forwarders-name': spec.eventForwardersName,
  })
}

/** update-role uses a different field-name set than create-role (see file header). */
export function buildUpdateRoleBody(spec: RoleSpec): Record<string, unknown> {
  return compactBody({
    name: spec.name,
    description: spec.description,
    delete_protection: boolFlag(spec.deleteProtection),
    'audit-access': spec.auditAccess,
    'analytics-access': spec.analyticsAccess,
    'gw-analytics-access': spec.gwAnalyticsAccess,
    'sra-reports-access': spec.sraReportsAccess,
    'usage-reports-access': spec.usageReportsAccess,
    'event-center-access': spec.eventCenterAccess,
    'isi-access': spec.isiAccess,
    'reverse-rbac-access': spec.reverseRbacAccess,
    'event-forwarder-access': spec.eventForwardersAccess,
  })
}

function ruleKey(path: string, ruleType: string): string {
  return `${ruleType}::${path}`
}

/** Additive-only: create/update every declared rule; never delete an undeclared one (see canvas.yaml). */
export async function reconcileRules(client: AkeylessClient, spec: RoleSpec, liveRules: LivePathRule[]): Promise<RuleRollbackEntry[]> {
  const liveByKey = new Map<string, LivePathRule>()
  for (const r of liveRules) {
    if (r.path && r.type) liveByKey.set(ruleKey(r.path, r.type), r)
  }

  const rollback: RuleRollbackEntry[] = []
  for (const rule of spec.rules) {
    const live = liveByKey.get(ruleKey(rule.path, rule.ruleType))
    const sameCapabilities = live && sameSet(live.capabilities ?? [], rule.capability)
    if (sameCapabilities) continue

    const res = await client.request('/set-role-rule', {
      'role-name': spec.name,
      path: rule.path,
      'rule-type': rule.ruleType,
      capability: rule.capability,
    })
    if (!res.ok) {
      throw new Error(`Failed to set rule "${rule.path}" (${rule.ruleType}) on role "${spec.name}": ${akeylessErrorMessage(res)}`)
    }
    rollback.push({ path: rule.path, ruleType: rule.ruleType, priorCapabilities: live?.capabilities })
  }
  return rollback
}

/** Full replace: role_auth_methods_assoc becomes exactly the declared set. */
export async function reconcileAssociations(
  client: AkeylessClient,
  spec: RoleSpec,
  liveAssocs: LiveRoleAssoc[],
): Promise<AssocRollbackEntry[]> {
  const liveByName = new Map<string, LiveRoleAssoc>()
  for (const a of liveAssocs) {
    if (a.auth_method_name) liveByName.set(a.auth_method_name, a)
  }
  const declaredNames = new Set(spec.authMethodAssociations.map((a) => a.authMethodName))
  const rollback: AssocRollbackEntry[] = []

  for (const assoc of spec.authMethodAssociations) {
    const live = liveByName.get(assoc.authMethodName)
    if (!live) {
      const res = await client.request('/assoc-role-am', {
        'role-name': spec.name,
        'am-name': assoc.authMethodName,
        'sub-claims': subClaimsToWireFormat(assoc.subClaims),
        'case-sensitive': boolFlag(assoc.caseSensitive),
      })
      if (res.status !== 409 && !res.ok) {
        throw new Error(`Failed to associate role "${spec.name}" with auth method "${assoc.authMethodName}": ${akeylessErrorMessage(res)}`)
      }
      rollback.push({ authMethodName: assoc.authMethodName })
    } else if (!sameAssoc(live, assoc)) {
      const res = await client.request('/update-assoc', {
        'assoc-id': live.assoc_id,
        'sub-claims': subClaimsToWireFormat(assoc.subClaims),
        'case-sensitive': boolFlag(assoc.caseSensitive),
      })
      if (!res.ok) {
        throw new Error(`Failed to update association for auth method "${assoc.authMethodName}" on role "${spec.name}": ${akeylessErrorMessage(res)}`)
      }
      rollback.push({
        authMethodName: assoc.authMethodName,
        assocId: live.assoc_id,
        prior: { subClaims: live.auth_method_sub_claims ?? {}, caseSensitive: live.sub_claims_case_sensitive !== false },
      })
    }
  }

  for (const [name, live] of liveByName) {
    if (declaredNames.has(name) || !live.assoc_id) continue
    const res = await client.request('/delete-assoc', { 'assoc-id': live.assoc_id })
    if (res.status !== 404 && !res.ok) {
      throw new Error(`Failed to remove association for auth method "${name}" on role "${spec.name}": ${akeylessErrorMessage(res)}`)
    }
    rollback.push({
      authMethodName: name,
      prior: { subClaims: live.auth_method_sub_claims ?? {}, caseSensitive: live.sub_claims_case_sensitive !== false },
    })
  }

  return rollback
}

/**
 * /assoc-role-am and /update-assoc take `sub-claims` as `{[key]: "v1,v2"}`
 * (a single comma-joined string per key) - but GetRole reads it back as
 * `{[key]: ["v1","v2"]}` (an array). Confirmed from the terraform provider's
 * own encode/decode (resource_role.go `addRoleAssocs`/`extractAssocValues`).
 */
function subClaimsToWireFormat(subClaims: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, values] of Object.entries(subClaims)) out[key] = values.join(',')
  return out
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

function sameAssoc(live: LiveRoleAssoc, declared: AssocSpec): boolean {
  const liveCaseSensitive = live.sub_claims_case_sensitive !== false
  if (liveCaseSensitive !== declared.caseSensitive) return false
  const liveClaims = live.auth_method_sub_claims ?? {}
  const liveKeys = Object.keys(liveClaims)
  const declaredKeys = Object.keys(declared.subClaims)
  if (liveKeys.length !== declaredKeys.length) return false
  return declaredKeys.every((k) => sameSet(liveClaims[k] ?? [], declared.subClaims[k] ?? []))
}
