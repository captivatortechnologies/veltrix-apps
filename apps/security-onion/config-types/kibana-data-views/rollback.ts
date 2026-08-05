import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, sendJson } from '../../lib/soConsole'

/**
 * Undo a data-views deploy from rollbackData.previous (written by deploy()):
 * for each entry, restore the prior title/name/timeFieldName, or DELETE the
 * data view we created (its prior value was null). Applied over the SOC
 * console REST API (443).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ dataViewId: string; dataView: Record<string, unknown> | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for data view rollback' }
  }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }

  let restored = 0
  let deleted = 0
  try {
    for (const { dataViewId, dataView } of previous) {
      const path = `${base}/api/data_views/data_view/${encodeURIComponent(dataViewId)}`
      if (dataView) {
        await sendJson('POST', path, headers, {
          data_view: { title: dataView.title, name: dataView.name, timeFieldName: dataView.timeFieldName },
        })
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return { success: true, message: `Rolled back data views: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
