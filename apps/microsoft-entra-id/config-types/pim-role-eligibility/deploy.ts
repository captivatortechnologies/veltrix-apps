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
  /** Whether the eligibility already existed before this deploy. */
  existed: boolean
  /** Prior eligibility window, captured when this deploy UPDATED an existing one. */
  priorExpiration?: ExpirationPattern
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

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

async function listLiveSchedules(client: GraphClient): Promise<{ ok: boolean; byKey: Map<string, LiveEligibilitySchedule>; error?: string }> {
  const listed = await client.getAll<LiveEligibilitySchedule>(`${SCHEDULES}${SCHEDULE_SELECT}`)
  const byKey = new Map<string, LiveEligibilitySchedule>()
  if (!listed.ok) return { ok: false, byKey, error: graphErrorMessage(listed.lastError!) }
  for (const s of listed.items) {
    if (s.principalId && s.roleDefinitionId) {
      byKey.set(eligibilityKey(s.principalId, s.roleDefinitionId, s.directoryScopeId ?? '/'), s)
    }
  }
  return { ok: true, byKey }
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

  const prior = await loadPriorEntries(ctx)
  const entries: RollbackEntry[] = []
  const failures: string[] = []
  const pending: string[] = []

  for (const spec of specs) {
    const key = eligibilityKey(spec.principalId, spec.roleDefinitionId, spec.directoryScopeId)
    const match = live.byKey.get(key)
    const label = eligibilityLabel(spec)

    let action: EligibilityAction
    let priorExpiration: ExpirationPattern | undefined
    if (!match) {
      action = 'adminAssign'
    } else {
      // Present already — only emit a request when the eligibility window differs.
      const diff = expirationDiff(spec, match)
      if (!diff) continue
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
      existed: Boolean(match),
      priorExpiration,
    })

    if (PENDING_APPROVAL_STATUSES.has(status) || (status && !APPLIED_STATUSES.has(status))) {
      pending.push(`${label} (${status || 'pending'})`)
    }
  }

  // Reconcile: revoke eligibilities THIS app created previously but no longer declares.
  const declaredKeys = new Set(specs.map((s) => eligibilityKey(s.principalId, s.roleDefinitionId, s.directoryScopeId)))
  for (const p of prior) {
    if (p.existed || p.action !== 'adminAssign') continue
    const key = eligibilityKey(p.principalId, p.roleDefinitionId, p.directoryScopeId)
    if (declaredKeys.has(key)) continue
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
  return {
    success: true,
    message: `Applied ${entries.length} eligibility request(s)${pendingNote}`,
    rollbackData: { entries },
  }
}
