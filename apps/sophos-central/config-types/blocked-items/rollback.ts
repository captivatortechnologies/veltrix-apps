import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createBlockedItem, deleteBlockedItem } from '../../lib/sophosApi'
import type { BlockedItemRollbackEntry } from './deploy'

/**
 * Roll back blocked items using the state captured during deploy:
 *   - created items are deleted
 *   - replaced items have their new copy deleted and the prior copy recreated
 *     (Sophos assigns a new id — there is no "restore by id")
 *   - unchanged items are left alone
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: BlockedItemRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created') {
        if (entry.newId) await deleteBlockedItem(client, entry.newId)
      } else if (entry.action === 'replaced') {
        if (entry.newId) await deleteBlockedItem(client, entry.newId)
        if (entry.prior) await createBlockedItem(client, entry.prior)
      }
      reverted.push(entry.sha256)
    }
    return { success: true, message: `Rolled back ${reverted.length} blocked item(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
