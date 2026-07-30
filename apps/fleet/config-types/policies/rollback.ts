import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { findPolicyByName, type FleetPolicy } from './_shared'

/**
 * Undo a global-policy deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH the prior policy fields back, or delete the policy we
 * created (its prior body was null). Fleet deletes global policies by id via
 * POST /api/v1/fleet/global/policies/delete { ids } — the created ids aren't in
 * rollbackData, so we re-find them by name first. Verify against a live Fleet
 * (fleetdm) instance.
 */
function priorBody(p: FleetPolicy): Record<string, unknown> {
  return {
    name: p.name,
    query: p.query ?? '',
    description: p.description ?? '',
    resolution: p.resolution ?? '',
    platform: p.platform ?? '',
    critical: p.critical ?? false,
  }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ name: string; policy: FleetPolicy | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for global-policy rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const createdIds: number[] = []
  let restored = 0
  try {
    for (const { name, policy } of previous) {
      if (policy) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/global/policies/${policy.id}`, headers, priorBody(policy))
        restored++
      } else {
        const live = await findPolicyByName(base, headers, name)
        if (live) createdIds.push(live.id)
      }
    }
    if (createdIds.length > 0) {
      await sendJson('POST', `${base}${FLEET_API_BASE}/global/policies/delete`, headers, { ids: createdIds })
    }
    return { success: true, message: `Rolled back global policies: ${restored} restored, ${createdIds.length} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
