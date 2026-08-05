import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { createAllowedItem, deleteAllowedItem, updateAllowedItem } from '../../lib/sophosApi'
import type { AllowedItemRollbackEntry } from './deploy'

/**
 * Roll back allowed items using the state captured during deploy:
 *   - created items are deleted
 *   - patched items have their comment restored
 *   - replaced items have their new copy deleted and the prior copy recreated
 *   - unchanged items are left alone
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: AllowedItemRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (entry.action === 'created') {
        if (entry.newId) await deleteAllowedItem(client, entry.newId)
      } else if (entry.action === 'patched') {
        if (entry.newId) await updateAllowedItem(client, entry.newId, entry.priorComment ?? '')
      } else if (entry.action === 'replaced') {
        if (entry.newId) await deleteAllowedItem(client, entry.newId)
        if (entry.prior) await createAllowedItem(client, entry.prior)
      }
      reverted.push(entry.key)
    }
    return { success: true, message: `Rolled back ${reverted.length} allowed item(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
