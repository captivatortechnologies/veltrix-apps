import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { deleteEndpointGroup, updateEndpointGroup } from '../../lib/sophosApi'
import { reconcileMembership, type EndpointGroupRollbackEntry } from './deploy'

/**
 * Roll back endpoint groups using the state captured during deploy:
 *   - groups that were created are deleted (removes their membership too)
 *   - groups that were updated have name/description restored and membership
 *     reconciled back to the captured prior snapshot
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous = (ctx.rollbackData as { previous?: EndpointGroupRollbackEntry[] } | undefined)?.previous
  if (!previous || previous.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previous].reverse()) {
      if (!entry.existed) {
        if (entry.id) await deleteEndpointGroup(client, entry.id)
      } else if (entry.id) {
        if (entry.priorDetails) {
          await updateEndpointGroup(client, entry.id, { name: entry.priorDetails.name, description: entry.priorDetails.description })
        }
        if (entry.priorMembers) {
          await reconcileMembership(client, entry.id, entry.priorMembers)
        }
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} endpoint group(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previous.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
