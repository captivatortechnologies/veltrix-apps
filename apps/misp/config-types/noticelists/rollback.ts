import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'

/**
 * Undo a noticelists deploy from rollbackData.previous (written by deploy()): for
 * each entry, POST /noticelists/enableNoticelist/<id>[/true] to restore its prior
 * enabled state. Applied over the MISP REST API (443). Verify
 * /noticelists/enableNoticelist/<id>[/true] against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; noticelistId: number | string; enabledBefore: boolean }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for noticelist rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { noticelistId, enabledBefore } of previous) {
      const path = enabledBefore
        ? `${base}/noticelists/enableNoticelist/${encodeURIComponent(String(noticelistId))}/true`
        : `${base}/noticelists/enableNoticelist/${encodeURIComponent(String(noticelistId))}`
      await sendJson('POST', path, headers, {})
      restored++
    }
    return { success: true, message: `Rolled back ${restored} noticelist(s) to their prior enabled state.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
