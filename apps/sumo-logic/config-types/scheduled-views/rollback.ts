import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'

/**
 * Undo a scheduled-views deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /scheduledViews/<id> with the prior mutable-subset body
 * (restore), or — when the view was newly created (prior body null) — DELETE
 * /scheduledViews/<id>/disable. Scheduled views cannot be truly deleted, only
 * disabled — this is a best-effort undo, not a full removal.
 *
 * API: https://www.sumologic.com/help/docs/api/scheduled-views/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ indexName: string; viewId: string | null; priorUpdateBody: Record<string, unknown> | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for scheduled view rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let disabled = 0
  let skipped = 0
  try {
    for (const { viewId, priorUpdateBody } of previous) {
      if (viewId == null) {
        // A created view whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (priorUpdateBody) {
        await sendJson('PUT', `${base}/scheduledViews/${encodeURIComponent(viewId)}`, headers, priorUpdateBody)
        restored++
      } else {
        await sendJson('DELETE', `${base}/scheduledViews/${encodeURIComponent(viewId)}/disable`, headers)
        disabled++
      }
    }
    return {
      success: true,
      message: `Rolled back scheduled views: ${restored} restored, ${disabled} disabled${skipped ? `, ${skipped} skipped` : ''} (scheduled views cannot be permanently deleted).`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
