import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import type { Monitor } from './_shared'

/**
 * Undo a monitors deploy from rollbackData.previous (written by deploy()): for
 * each entry, re-read the monitor's CURRENT live version (Sumo Logic's update
 * is optimistic-concurrency versioned — the version captured before our own
 * update is now stale) then PUT the prior body with that fresh version
 * (restore), or — when the monitor was newly created (prior body null) —
 * DELETE it via the bulk-delete endpoint. Applied over the Sumo Logic
 * Management API.
 *
 * API: https://help.sumologic.com/docs/api/monitors/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; monitorId: string | null; monitor: Monitor | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for monitor rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let skipped = 0
  const idsToDelete: string[] = []

  try {
    for (const { monitorId, monitor } of previous) {
      if (monitorId == null) {
        // A created monitor whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (monitor) {
        const current = await getJson<Monitor>(`${base}/monitors/${encodeURIComponent(monitorId)}`, headers)
        const { id: _id, version: _v, ...body } = monitor
        await sendJson('PUT', `${base}/monitors/${encodeURIComponent(monitorId)}`, headers, { ...body, version: current.version })
        restored++
      } else {
        idsToDelete.push(monitorId)
      }
    }

    if (idsToDelete.length) {
      await sendJson('DELETE', `${base}/monitors?ids=${idsToDelete.map(encodeURIComponent).join(',')}`, headers)
    }

    return {
      success: true,
      message: `Rolled back monitors: ${restored} restored, ${idsToDelete.length} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
