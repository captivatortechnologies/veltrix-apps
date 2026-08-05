import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, sendJson } from '../../lib/soarApi'

/**
 * Undo a custom lists deploy from rollbackData.previous: a NEWLY CREATED list
 * is deleted via DELETE /rest/decided_list/<id>; a list that existed before
 * the deploy is restored via POST /<id> with its captured prior content, when
 * that content was successfully captured at deploy time. Custom Lists' DELETE
 * accepts either a user-authenticated credential or an automation API token —
 * unlike every other type in this app, this rollback is not blocked by a
 * token-only credential (see lib/soarApi.ts DELETE_AUTH_HINT).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; listId: number | string | null; existedBefore: boolean; content: string[][] | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for custom list rollback' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let removed = 0
  let skipped = 0
  try {
    for (const { listId, existedBefore, content } of previous) {
      if (listId == null) continue
      const url = `${base}/rest/decided_list/${encodeURIComponent(String(listId))}`
      if (!existedBefore) {
        await sendJson('DELETE', url, headers)
        removed++
      } else if (content) {
        await sendJson('POST', url, headers, { content })
        restored++
      } else {
        skipped++ // existed before, but its prior content couldn't be captured at deploy time
      }
    }
    const skippedNote = skipped
      ? ` ${skipped} updated list(s) were NOT restored — their prior content could not be read at deploy time.`
      : ''
    return { success: true, message: `Rolled back custom lists: ${restored} restored, ${removed} removed.${skippedNote}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
