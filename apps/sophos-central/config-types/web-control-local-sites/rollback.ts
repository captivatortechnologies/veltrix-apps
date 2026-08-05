import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { deleteLocalSite, updateLocalSite } from '../../lib/sophosApi'
import type { LocalSiteRollbackEntry } from './deploy'

/**
 * Roll back local sites using the state captured during deploy:
 *   - sites that were created are deleted
 *   - sites that were updated are restored to their captured prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: LocalSiteRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        if (entry.id) await deleteLocalSite(client, entry.id)
      } else if (entry.id && entry.prior) {
        await updateLocalSite(client, entry.id, { categoryId: entry.prior.categoryId, tags: entry.prior.tags, comment: entry.prior.comment })
      }
      reverted.push(entry.url)
    }
    return { success: true, message: `Rolled back ${reverted.length} local site(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
