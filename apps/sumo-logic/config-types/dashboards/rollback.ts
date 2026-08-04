import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import type { Dashboard } from './_shared'

/**
 * Undo a dashboards deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /dashboards/<id> with the prior full body (restore), or —
 * when the dashboard was newly created (prior body null) — DELETE
 * /dashboards/<id> to remove it. Applied over the Sumo Logic Management API v2.
 *
 * API: https://help.sumologic.com/docs/api/dashboards-v2/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; dashboardId: string | null; dashboard: Dashboard | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for dashboard rollback' }
  }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { dashboardId, dashboard } of previous) {
      if (dashboardId == null) {
        // A created dashboard whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/dashboards/${encodeURIComponent(dashboardId)}`
      if (dashboard) {
        const { id: _id, ...body } = dashboard
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back dashboards: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
