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
  desiredExpiration,
  eligibilityKey,
  eligibilityLabel,
  expirationDiff,
  extractEligibilitySpecs,
  normalizeScope,
  type EligibilitySpec,
  type ExpirationPattern,
  type LiveEligibilitySchedule,
} from './validate'
import { buildRoleNameToId, resolveRef } from '../lib/nameMaps'
import { buildPrincipalNameMaps, resolvePrincipal, type PrincipalNameMaps } from '../lib/principals'
import { buildDirectoryScopeNameMaps, resolveDirectoryScope, type DirectoryScopeNameMaps } from '../lib/directoryScope'

const SCHEDULES = '/roleManagement/directory/roleEligibilitySchedules'
const REQUESTS = '/roleManagement/directory/roleEligibilityScheduleRequests'
const SCHEDULE_SELECT = '?$select=id,principalId,roleDefinitionId,directoryScopeId,status,scheduleInfo'

type EligibilityAction = 'adminAssign' | 'adminUpdate'

/** PIM request statuses that mean the change is applied. */
const APPLIED_STATUSES = new Set(['Provisioned', 'Granted', 'ScheduleCreated', 'PendingProvisioning', 'PendingScheduleCreation'])
/** Statuses that mean the request awaits approval — reported, not failed. */
const PENDING_APPROVAL_STATUSES = new Set(['PendingApproval', 'PendingAdminDecision'])
/** Statuses that mean the request was rejected outright. */
const FAILED_STATUSES = new Set(['Failed', 'Denied', 'Canceled'])

export interface RollbackEntry {
  itemId?: string
  /** Human label for the eligibility. */
  name: string
  principalId: string
  roleDefinitionId: string
  directoryScopeId: string
  /** What this deploy did to the eligibility. */
  action: EligibilityAction
  /** Provenance: false = created by this app (sticky across deploys), true = pre-existing. */
  existed: boolean
  /** Prior eligibility window, captured when this deploy UPDATED an existing one. */
  priorExpiration?: ExpirationPattern
  /** True = this deploy made NO change (entry only carries provenance forward);
   *  rollback skips it and no request was issued. */
  carried?: boolean
}

/** Build a unifiedRoleEligibilityScheduleRequest body for a given action. */
export function buildRequestBody(
  action: EligibilityAction | 'adminRemove',
  spec: Pick<EligibilitySpec, 'principalId' | 'roleDefinitionId' | 'directoryScopeId' | 'justification' | 'ticketNumber' | 'ticketSystem'>,
  expiration?: ExpirationPattern,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action,
    principalId: spec.principalId,
    roleDefinitionId: spec.roleDefinitionId,
    directoryScopeId: normalizeScope(spec.directoryScopeId),
    justification: spec.justification || 'Managed by Veltrix config as code',
  }
  // scheduleInfo is not carried on a removal (the eligibility is being revoked).
  if (action !== 'adminRemove' && expiration) {
    body.scheduleInfo = { expiration }
  }
  if (spec.ticketNumber || spec.ticketSystem) {
    body.ticketInfo = { ticketNumber: spec.ticketNumber || null, ticketSystem: spec.ticketSystem || null }
  }
  return body
}

interface NameMaps {
  role: Map<string, string>
  principal: PrincipalNameMaps
  scope: DirectoryScopeNameMaps
}

async function buildNameMaps(client: GraphClient): Promise<NameMaps> {
  const [role, principal, scope] = await Promise.all([
    buildRoleNameToId(client),
    buildPrincipalNameMaps(client),
    buildDirectoryScopeNameMaps(client),
  ])
  return { role, principal, scope }
}

/**
 * Resolve one spec's principal/role/scope references, leaving every other
 * field (justification, ticketing, expiration window) untouched. A
 * picker-selected value passes straight through; a hand-typed display name
 * resolves via the live maps built once per deploy/drift run.
 */
export function resolveEligibilitySpec(
  spec: EligibilitySpec,
  maps: NameMaps
): { resolved: EligibilitySpec; missing: string[] } {
  const role = resolveRef(spec.roleDefinitionId, maps.role)
  const principal = resolvePrincipal(spec.principalId, maps.principal)
  const scope = resolveDirectoryScope(spec.directoryScopeId, maps.scope)
  const missing = [
    ...(role.missing ? [spec.roleDefinitionId] : []),
    ...(principal.missing ? [spec.principalId] : []),
    ...(scope.missing ? [scope.missing] : []),
  ]
  return {
    resolved: { ...spec, principalId: principal.id, roleDefinitionId: role.id, directoryScopeId: scope.scope || '/' },
    missing,
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

async function listLiveSchedules(
  client: GraphClient,
): Promise<{ ok: boolean; byKey: Map<string, LiveEligibilitySchedule>; truncated: boolean; error?: string }> {
  const listed = await client.getAll<LiveEligibilitySchedule>(`${SCHEDULES}${SCHEDULE_SELECT}`)
  const byKey = new Map<string, LiveEligibilitySchedule>()
  if (!listed.ok) return { ok: false, byKey, truncated: false, error: graphErrorMessage(listed.lastError!) }
  for (const s of listed.items) {
    if (s.principalId && s.roleDefinitionId) {
      byKey.set(eligibilityKey(s.principalId, s.roleDefinitionId, s.directoryScopeId ?? '/'), s)
    }
  }
  return { ok: true, byKey, truncated: listed.truncated }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractEligibilitySpecs(ctx.canvas).filter((s) => s.principalId && s.roleDefinitionId)

  const live = await listLiveSchedules(client)
  if (!live.ok) {
    return { success: false, message: `Failed to list role eligibility schedules: ${live.error}` }
  }
  // A truncated listing would mis-read an existing eligibility as "missing" and
  // re-issue a privileged adminAssign — fail safe instead.
  if (live.truncated) {
    return {
      success: false,
      message: `Cannot safely reconcile role eligibility: the schedule listing was truncated at ~${live.byKey.size}+ entries, so a declared eligibility could be mis-detected as missing and re-requested. Reduce the number of managed eligibilities or contact support.`,
    }
  }

  // Resolve every spec's principal/role/scope references once, using name
  // maps built once for the whole deploy (mirrors conditional-access-policies).
  const maps = await buildNameMaps(client)

  const prior = await loadPriorEntries(ctx)
  const priorByKey = new Map(
    prior.map((e) => [eligibilityKey(e.principalId, e.roleDefinitionId, e.directoryScopeId), e]),
  )
  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const pending: string[] = []
  const declaredKeys = new Set<string>()

  for (const rawSpec of specs) {
    const { resolved: spec, missing } = resolveEligibilitySpec(rawSpec, maps)
    if (missing.length) {
      failures.push(`${eligibilityLabel(rawSpec)}: unknown target(s) ${missing.join(', ')} — create/verify them first or fix the name`)
      continue
    }

    const key = eligibilityKey(spec.principalId, spec.roleDefinitionId, spec.directoryScopeId)
    declaredKeys.add(key)
    const match = live.byKey.get(key)
    const label = eligibilityLabel(spec)
    // Sticky provenance: once this app created the eligibility (existed:false),
    // keep it marked created across deploys, so a later removal still revokes it.
    const stickyExisted = priorByKey.get(key)?.existed === false ? false : Boolean(match)

    let action: EligibilityAction
    let priorExpiration: ExpirationPattern | undefined
    if (!match) {
      action = 'adminAssign'
    } else {
      // Present already — only emit a request when the eligibility window differs.
      const diff = expirationDiff(spec, match)
      if (!diff) {
        // No change this deploy — record a carried entry so provenance (whether we
        // created it) survives to the next deploy's reconcile. Rollback skips it.
        entries.push({
          itemId: spec.itemId,
          name: label,
          principalId: spec.principalId,
          roleDefinitionId: spec.roleDefinitionId,
          directoryScopeId: normalizeScope(spec.directoryScopeId),
          action: 'adminAssign',
          existed: stickyExisted,
          carried: true,
        })
        continue
      }
      action = 'adminUpdate'
      priorExpiration = match.scheduleInfo?.expiration ?? { type: 'noExpiration' }
    }

    const resp = await client.post(REQUESTS, buildRequestBody(action, spec, desiredExpiration(spec)))
    if (!resp.ok) {
      failures.push(`${label}: ${graphErrorMessage(resp)}`)
      continue
    }

    const created = parseJson<{ status?: string }>(resp.body)
    const status = created?.status ?? ''
    if (FAILED_STATUSES.has(status)) {
      failures.push(`${label}: request ${status.toLowerCase()}`)
      continue
    }

    entries.push({
      itemId: spec.itemId,
      name: label,
      principalId: spec.principalId,
      roleDefinitionId: spec.roleDefinitionId,
      directoryScopeId: normalizeScope(spec.directoryScopeId),
      action,
      existed: stickyExisted,
      priorExpiration,
    })

    if (PENDING_APPROVAL_STATUSES.has(status) || (status && !APPLIED_STATUSES.has(status))) {
      pending.push(`${label} (${status || 'pending'})`)
    }
  }

  // Reconcile: revoke eligibilities THIS app created previously but no longer
  // declares. Keyed on provenance (existed:false) alone — an app-created
  // eligibility that was later updated (or unchanged) must still be revoked, so we
  // no longer also require the last action to have been adminAssign. A spec
  // whose reference failed to resolve THIS run is still "declared" by canvas
  // item — protected via itemId — so a transient lookup failure never revokes
  // an eligibility the user still intends to keep.
  const declaredItemIds = new Set(specs.map((s) => s.itemId).filter((v): v is string => Boolean(v)))
  for (const p of prior) {
    if (p.existed) continue
    const key = eligibilityKey(p.principalId, p.roleDefinitionId, p.directoryScopeId)
    if (declaredKeys.has(key) || (p.itemId && declaredItemIds.has(p.itemId))) continue
    // Only revoke if it is actually still present as an applied eligibility.
    if (!live.byKey.has(key)) continue
    const removeSpec = {
      principalId: p.principalId,
      roleDefinitionId: p.roleDefinitionId,
      directoryScopeId: p.directoryScopeId,
      justification: 'Removed by Veltrix config as code',
      ticketNumber: '',
      ticketSystem: '',
    }
    const resp = await client.post(REQUESTS, buildRequestBody('adminRemove', removeSpec))
    if (!resp.ok) failures.push(`revoke ${p.name}: ${graphErrorMessage(resp)}`)
  }

  const pendingNote = pending.length ? ` (${pending.length} awaiting approval/provisioning: ${pending.join(', ')})` : ''

  if (failures.length) {
    return {
      success: false,
      message: `Some eligibility requests failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  // Count only real requests — carried entries issued no request (no-op provenance).
  const applied = entries.filter((e) => !e.carried).length
  return {
    success: true,
    message: `Applied ${applied} eligibility request(s)${pendingNote}`,
    rollbackData: { entries },
  }
}
