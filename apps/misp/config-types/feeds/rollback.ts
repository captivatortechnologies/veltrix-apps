import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispFeed } from './_shared'

/**
 * Undo a feeds deploy from rollbackData.previous (written by deploy()): for each
 * entry, POST /feeds/edit/<id> with the prior feed body (restore), or — when the
 * feed was newly created (prior body null) — POST /feeds/edit/<id> with
 * { enabled: false } to disable it. MISP has no simple feed delete over this seam,
 * so a created feed is disabled rather than removed. Applied over the MISP REST
 * API (443). Verify /feeds/edit/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; url: string; feedId: number | string | null; feed: MispFeed | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for threat feed rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let disabled = 0
  let skipped = 0
  try {
    for (const { feedId, feed } of previous) {
      if (feedId == null) {
        // A created feed whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/feeds/edit/${encodeURIComponent(String(feedId))}`
      if (feed) {
        await sendJson('POST', path, headers, { Feed: feed })
        restored++
      } else {
        await sendJson('POST', path, headers, { Feed: { enabled: false } })
        disabled++
      }
    }
    return {
      success: true,
      message: `Rolled back threat feeds: ${restored} restored, ${disabled} disabled${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
