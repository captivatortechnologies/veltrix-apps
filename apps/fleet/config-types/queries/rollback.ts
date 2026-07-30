import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import type { FleetQuery } from './_shared'

/**
 * Undo a saved-query deploy from rollbackData.previous (written by deploy()): for
 * each entry, PATCH the prior query fields back, or DELETE the query we created
 * (its prior body was null). Applied over the Fleet REST API. Delete-by-name uses
 * DELETE /api/v1/fleet/queries/{name} — verify against a live Fleet (fleetdm)
 * instance.
 */
function priorBody(q: FleetQuery): Record<string, unknown> {
  return {
    name: q.name,
    query: q.query ?? '',
    description: q.description ?? '',
    interval: q.interval ?? 0,
    platform: q.platform ?? '',
    observer_can_run: q.observer_can_run ?? false,
  }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ name: string; query: FleetQuery | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for saved-query rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { name, query } of previous) {
      if (query) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/queries/${query.id}`, headers, priorBody(query))
        restored++
      } else {
        await sendJson('DELETE', `${base}${FLEET_API_BASE}/queries/${encodeURIComponent(name)}`, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back saved queries: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
