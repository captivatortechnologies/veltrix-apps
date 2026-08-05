import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { deletePolicy, updatePolicy } from '../../lib/sophosApi'
import type { PolicyRollbackEntry } from './deploy'

/**
 * Roll back endpoint policies using the state captured during deploy:
 *   - policies that were created are deleted
 *   - policies that were updated are restored to their captured prior body
 *     (name/enabled/priority/disableAt/appliesTo/settings — `type` never
 *     changes)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: PolicyRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        if (entry.id) await deletePolicy(client, entry.id)
      } else if (entry.id && entry.prior) {
        await updatePolicy(client, entry.id, {
          name: entry.prior.name,
          enabled: entry.prior.enabled,
          priority: entry.prior.priority,
          disableAt: entry.prior.disableAt,
          appliesTo: entry.prior.appliesTo,
          settings: entry.prior.settings,
        })
      }
      reverted.push(entry.key)
    }
    return { success: true, message: `Rolled back ${reverted.length} endpoint polic${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
