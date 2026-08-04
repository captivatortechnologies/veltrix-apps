import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type GraphClient,
} from '../../lib/graph'
import {
  extractPolicySpecs,
  mapCanvasStateToGraph,
  type CaPolicySpec,
  type LiveCaPolicy,
} from './validate'

const BASE = '/identity/conditionalAccess/policies'

/** A Graph object id — the shape every live picker on this canvas stores as a field's value. */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isGuid(v: string): boolean {
  return GUID.test(v)
}

export interface RollbackEntry {
  itemId?: string
  name: string
  /** Whether the policy existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  id?: string
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

// --- Live displayName -> id maps ---------------------------------------------
// Each mirrors buildGroupNameToId: built once per deploy/drift run and reused
// for every policy item. A failed listing (missing Graph permission or —
// specifically for terms of use, see options.ts — Graph's documented lack of
// application-permission support for that one endpoint) returns an EMPTY map
// rather than throwing, so a picker-selected GUID still resolves fine and
// only a hand-typed, unresolvable NAME surfaces as a clear "missing" error.

/** Build a case-insensitive group displayName → id map from the live directory. */
export async function buildGroupNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>('/groups?$select=id,displayName')
  if (listed.ok) {
    for (const g of listed.items) {
      if (g.displayName && g.id) map.set(g.displayName.toLowerCase(), g.id)
    }
  }
  return map
}

/** Build a case-insensitive user displayName/UPN → id map from the live directory. */
export async function buildUserNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string; userPrincipalName?: string }>(
    '/users?$select=id,displayName,userPrincipalName'
  )
  if (listed.ok) {
    for (const u of listed.items) {
      if (!u.id) continue
      if (u.displayName) map.set(u.displayName.toLowerCase(), u.id)
      if (u.userPrincipalName) map.set(u.userPrincipalName.toLowerCase(), u.id)
    }
  }
  return map
}

/** Build a case-insensitive directory-role displayName → id map (roleManagement/directory/roleDefinitions). */
export async function buildRoleNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>(
    '/roleManagement/directory/roleDefinitions?$select=id,displayName'
  )
  if (listed.ok) {
    for (const r of listed.items) {
      if (r.id && r.displayName) map.set(r.displayName.toLowerCase(), r.id)
    }
  }
  return map
}

/** Build a case-insensitive named-location displayName → id map. */
export async function buildLocationNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>(
    '/identity/conditionalAccess/namedLocations?$select=id,displayName'
  )
  if (listed.ok) {
    for (const n of listed.items) {
      if (n.id && n.displayName) map.set(n.displayName.toLowerCase(), n.id)
    }
  }
  return map
}

/** Build a case-insensitive authenticationStrengthPolicy displayName → id map. */
export async function buildAuthStrengthNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>(
    '/policies/authenticationStrengthPolicies?$select=id,displayName'
  )
  if (listed.ok) {
    for (const p of listed.items) {
      if (p.id && p.displayName) map.set(p.displayName.toLowerCase(), p.id)
    }
  }
  return map
}

/** Build a case-insensitive terms-of-use agreement displayName → id map. */
export async function buildTermsOfUseNameToId(client: GraphClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const listed = await client.getAll<{ id?: string; displayName?: string }>(
    '/identityGovernance/termsOfUse/agreements?$select=id,displayName'
  )
  if (listed.ok) {
    for (const a of listed.items) {
      if (a.id && a.displayName) map.set(a.displayName.toLowerCase(), a.id)
    }
  }
  return map
}

// --- Id-aware resolution ------------------------------------------------------

/**
 * conditionalAccessUsers.include/excludeUsers sentinels
 * (https://learn.microsoft.com/graph/api/resources/conditionalaccessusers):
 * include documents `All`, `None`, `GuestsOrExternalUsers`; exclude documents
 * only `GuestsOrExternalUsers`. The resolver itself accepts either casing on
 * any of the three regardless of include/exclude — which sentinels are ever
 * OFFERED in the picker per field is enforced in options.ts, not here; this
 * just needs to not mis-resolve a known literal as a directory lookup.
 */
const USER_SENTINELS = new Map([
  ['all', 'All'],
  ['none', 'None'],
  ['guestsorexternalusers', 'GuestsOrExternalUsers'],
])

/**
 * conditionalAccessLocations.includeLocations sentinels
 * (https://learn.microsoft.com/graph/api/resources/conditionalaccesslocations)
 * — excludeLocations documents none.
 */
const LOCATION_SENTINELS = new Map([
  ['all', 'All'],
  ['alltrusted', 'AllTrusted'],
])

/** No sentinel is documented for conditionalAccessUsers.include/excludeRoles or grantControls.termsOfUse. */
const NO_SENTINELS = new Map<string, string>()

function resolveTargets(
  values: string[],
  nameToId: Map<string, string>,
  sentinels: Map<string, string>
): { ids: string[]; missing: string[] } {
  const ids: string[] = []
  const missing: string[] = []
  for (const v of values) {
    if (isGuid(v)) {
      ids.push(v)
      continue
    }
    const canonical = sentinels.get(v.toLowerCase())
    if (canonical) {
      ids.push(canonical)
      continue
    }
    const id = nameToId.get(v.toLowerCase())
    if (id) ids.push(id)
    else missing.push(v)
  }
  return { ids, missing }
}

/**
 * Resolve group references to ids; unresolved names are returned separately.
 *
 * The "Included/Excluded Groups" fields are now a live `remote-multiselect`
 * picker (config-types/lib/entraOptions, source "groups") that stores the
 * group's object id directly — so a value that already looks like a GUID is
 * used as-is, with no lookup. A hand-typed display name (the pre-picker
 * `textarea` convention, still valid for a canvas saved before this change)
 * falls back to the live name->id map exactly as before.
 */
export function resolveGroups(
  names: string[],
  nameToId: Map<string, string>
): { ids: string[]; missing: string[] } {
  return resolveTargets(names, nameToId, NO_SENTINELS)
}

/** Users: GUID or All/None/GuestsOrExternalUsers sentinel passthrough, else resolve by displayName/UPN. */
export function resolveUsers(values: string[], nameToId: Map<string, string>): { ids: string[]; missing: string[] } {
  return resolveTargets(values, nameToId, USER_SENTINELS)
}

/**
 * Roles: GUID passthrough, else resolve by displayName via buildRoleNameToId.
 *
 * The id space matches: `/roleManagement/directory/roleDefinitions` (the
 * "roleDefinitions" entraOptions source this field's picker uses) returns,
 * for a BUILT-IN role, the SAME GUID as its legacy directory-role template id
 * — confirmed by this app's own directory-role-assignments module ("Built-in
 * roles store their roleTemplateId as the roleDefinitionId", validate.ts) for
 * the sibling `/roleManagement/directory/roleAssignments.roleDefinitionId`
 * field, which is that same id space. Conditional Access's
 * conditionalAccessUsers.includeRoles/excludeRoles ("Role IDs...") uses this
 * identical space — no separate templateId lookup or remapping is needed.
 *
 * Only BUILT-IN directory roles are valid CA targets — administrative-unit
 * scoped roles and custom roles are explicitly unsupported ("Other role types
 * aren't supported, including administrative unit-scoped roles and custom
 * roles" — Microsoft Entra Conditional Access "Users, groups, and workload
 * identities", Directory roles section). This can't be checked offline in
 * validate.ts (custom vs built-in isn't visible without a live Graph call),
 * so an unsupported role selection surfaces as a clear Graph 4xx at deploy
 * time via graphErrorMessage rather than a local validation error.
 */
export function resolveRoles(values: string[], nameToId: Map<string, string>): { ids: string[]; missing: string[] } {
  return resolveTargets(values, nameToId, NO_SENTINELS)
}

/** Named locations: GUID or All/AllTrusted sentinel passthrough, else resolve by displayName. */
export function resolveLocations(
  values: string[],
  nameToId: Map<string, string>
): { ids: string[]; missing: string[] } {
  return resolveTargets(values, nameToId, LOCATION_SENTINELS)
}

/** Terms-of-use agreements: GUID passthrough, else resolve by displayName. */
export function resolveTermsOfUse(
  values: string[],
  nameToId: Map<string, string>
): { ids: string[]; missing: string[] } {
  return resolveTargets(values, nameToId, NO_SENTINELS)
}

/** Single-value id-aware resolve for grantControls.authenticationStrength (no sentinel — an optional policy reference). */
export function resolveAuthenticationStrength(
  value: string,
  nameToId: Map<string, string>
): { id: string; missing: boolean } {
  if (!value) return { id: '', missing: false }
  if (isGuid(value)) return { id: value, missing: false }
  const id = nameToId.get(value.toLowerCase())
  return id ? { id, missing: false } : { id: '', missing: true }
}

export interface ResolvedTargets {
  includeGroups: string[]
  excludeGroups: string[]
  includeUsers: string[]
  excludeUsers: string[]
  includeRoles: string[]
  excludeRoles: string[]
  includeLocations: string[]
  excludeLocations: string[]
  /** Resolved authenticationStrengthPolicy id, or '' when the field is unset. */
  authenticationStrengthId: string
  termsOfUse: string[]
}

export function buildPolicyBody(spec: CaPolicySpec, resolved: ResolvedTargets): Record<string, unknown> {
  const conditions: Record<string, unknown> = {
    users: {
      includeUsers: spec.includeAllUsers ? ['All'] : resolved.includeUsers,
      excludeUsers: resolved.excludeUsers,
      includeGroups: spec.includeAllUsers ? [] : resolved.includeGroups,
      excludeGroups: resolved.excludeGroups,
      includeRoles: spec.includeAllUsers ? [] : resolved.includeRoles,
      excludeRoles: resolved.excludeRoles,
    },
    applications: {
      includeApplications: spec.includeAllApps ? ['All'] : spec.includeApps,
    },
    clientAppTypes: ['all'],
  }

  // Only set conditions.locations when at least one side is populated — an
  // absent key means "no location restriction" (this app's deploy authors
  // conditions/grantControls as a full state replacement each run, the same
  // way conditions.applications.excludeApplications is already omitted
  // whenever unused, so omitting locations here correctly clears any
  // previously-declared restriction on a later deploy that removes it).
  if (resolved.includeLocations.length > 0 || resolved.excludeLocations.length > 0) {
    conditions.locations = {
      includeLocations: resolved.includeLocations,
      excludeLocations: resolved.excludeLocations,
    }
  }

  const grantControls: Record<string, unknown> = {
    operator: spec.grantOperator,
    builtInControls: spec.builtInControls,
  }
  if (resolved.authenticationStrengthId) {
    // grantControls.authenticationStrength is a reference to an
    // authenticationStrengthPolicy — only its "id" is needed on write
    // (https://learn.microsoft.com/powershell/module/microsoft.graph.identity.signins/new-mgidentityconditionalaccesspolicy,
    // GRANTCONTROLS notes: "AuthenticationStrength <...>: authenticationStrengthPolicy ... [Id <String>]").
    grantControls.authenticationStrength = { id: resolved.authenticationStrengthId }
  }
  if (resolved.termsOfUse.length > 0) {
    grantControls.termsOfUse = resolved.termsOfUse
  }

  return {
    displayName: spec.name,
    state: mapCanvasStateToGraph(spec.state),
    conditions,
    grantControls,
  }
}

function snapshotLive(live: LiveCaPolicy): Record<string, unknown> {
  return {
    displayName: live.displayName,
    state: live.state,
    conditions: live.conditions ?? {},
    grantControls: live.grantControls ?? null,
  }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)

  const listed = await client.getAll<LiveCaPolicy>(BASE)
  if (!listed.ok) {
    return { success: false, message: `Failed to list Conditional Access policies: ${graphErrorMessage(listed.lastError!)}` }
  }
  const liveByName = new Map<string, LiveCaPolicy>()
  const liveById = new Map<string, LiveCaPolicy>()
  for (const p of listed.items) {
    if (p.displayName) liveByName.set(p.displayName.toLowerCase(), p)
    if (p.id) liveById.set(p.id, p)
  }

  // Resolve every targeting field's display-name/UPN -> id map once for the whole deploy.
  const groupNameToId = await buildGroupNameToId(client)
  const userNameToId = await buildUserNameToId(client)
  const roleNameToId = await buildRoleNameToId(client)
  const locationNameToId = await buildLocationNameToId(client)
  const authStrengthNameToId = await buildAuthStrengthNameToId(client)
  const termsOfUseNameToId = await buildTermsOfUseNameToId(client)

  const prior = await loadPriorEntries(ctx)
  const priorByItemId = new Map(prior.filter((e) => e.itemId).map((e) => [e.itemId as string, e]))
  const priorByName = new Map(prior.map((e) => [e.name.toLowerCase(), e]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const inc = resolveGroups(spec.includeAllUsers ? [] : spec.includeGroups, groupNameToId)
    const exc = resolveGroups(spec.excludeGroups, groupNameToId)
    const incUsers = resolveUsers(spec.includeAllUsers ? [] : spec.includeUsers, userNameToId)
    const excUsers = resolveUsers(spec.excludeUsers, userNameToId)
    const incRoles = resolveRoles(spec.includeAllUsers ? [] : spec.includeRoles, roleNameToId)
    const excRoles = resolveRoles(spec.excludeRoles, roleNameToId)
    const incLocations = resolveLocations(spec.includeLocations, locationNameToId)
    const excLocations = resolveLocations(spec.excludeLocations, locationNameToId)
    const authStrength = resolveAuthenticationStrength(spec.authenticationStrength, authStrengthNameToId)
    const termsOfUse = resolveTermsOfUse(spec.termsOfUse, termsOfUseNameToId)

    const missing = [
      ...inc.missing,
      ...exc.missing,
      ...incUsers.missing,
      ...excUsers.missing,
      ...incRoles.missing,
      ...excRoles.missing,
      ...incLocations.missing,
      ...excLocations.missing,
      ...termsOfUse.missing,
      ...(authStrength.missing ? [spec.authenticationStrength] : []),
    ]
    if (missing.length) {
      failures.push(`${spec.name}: unknown target(s) ${missing.join(', ')} — create/verify them first or fix the name`)
      continue
    }

    const body = buildPolicyBody(spec, {
      includeGroups: inc.ids,
      excludeGroups: exc.ids,
      includeUsers: incUsers.ids,
      excludeUsers: excUsers.ids,
      includeRoles: incRoles.ids,
      excludeRoles: excRoles.ids,
      includeLocations: incLocations.ids,
      excludeLocations: excLocations.ids,
      authenticationStrengthId: authStrength.id,
      termsOfUse: termsOfUse.ids,
    })

    const priorEntry = (spec.itemId && priorByItemId.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
    const liveMatch =
      (priorEntry?.id ? liveById.get(priorEntry.id) : undefined) ?? liveByName.get(spec.name.toLowerCase()) ?? null

    if (liveMatch?.id) {
      const resp = await client.patch(`${BASE}/${liveMatch.id}`, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, id: liveMatch.id, prior: snapshotLive(liveMatch) })
    } else {
      const resp = await client.post(BASE, body)
      if (!resp.ok) {
        failures.push(`${spec.name}: ${graphErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveCaPolicy>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, id: created?.id })
    }
  }

  // Reconcile: delete policies THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.id).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.id && !keptIds.has(p.id) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${BASE}/${p.id}`)
      if (!resp.ok && resp.status !== 404) {
        failures.push(`delete ${p.name}: ${graphErrorMessage(resp)}`)
      }
    }
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some policies failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Deployed ${entries.length} Conditional Access policy(ies)`,
    rollbackData: { entries },
  }
}
