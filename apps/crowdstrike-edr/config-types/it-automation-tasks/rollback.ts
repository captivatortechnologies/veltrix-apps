import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import { IT_TASK_ENDPOINTS, type ITTaskRollbackEntry } from './deploy'

/**
 * Roll back IT automation tasks using the state captured during deploy:
 *   - tasks that were created are deleted
 *   - tasks that were updated are patched back to their prior description,
 *     type, content, and parameters
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ITTaskRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this task — remove it. Re-resolve by identity so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findEntityByIdentity(client, IT_TASK_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, IT_TASK_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this task — restore the captured prior values.
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          description: entry.prior.description ?? '',
        }
        if (entry.prior.task_type !== undefined) restore.task_type = entry.prior.task_type
        if (entry.prior.os_query !== undefined) restore.os_query = entry.prior.os_query
        if (entry.prior.remediations !== undefined) restore.remediations = entry.prior.remediations
        restore.task_parameters = entry.prior.task_parameters ?? []

        await updateEntity(client, IT_TASK_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} IT automation task(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} task(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
