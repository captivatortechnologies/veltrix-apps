import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import type { FleetLabel } from './_shared'

/**
 * Undo a label deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH the prior label fields back, or DELETE the label we created (its
 * prior body was null). Fleet deletes labels by name via DELETE /api/v1/fleet/
 * labels/{name}. Verify against a live Fleet (fleetdm) instance.
 */
function priorBody(l: FleetLabel): Record<string, unknown> {
  return {
    name: l.name,
    description: l.description ?? '',
    query: l.query ?? '',
    platform: l.platform ?? '',
  }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ name: string; label: FleetLabel | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for label rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { name, label } of previous) {
      if (label) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/labels/${label.id}`, headers, priorBody(label))
        restored++
      } else {
        await sendJson('DELETE', `${base}${FLEET_API_BASE}/labels/${encodeURIComponent(name)}`, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back labels: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
