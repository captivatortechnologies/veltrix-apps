import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import { IT_SCHEDULED_TASK_ENDPOINTS, type ScheduledTaskRollbackEntry } from './deploy'

/**
 * Roll back scheduled tasks using the state captured during deploy:
 *   - scheduled tasks that were created are deleted
 *   - scheduled tasks that were updated are patched back to their prior
 *     enablement and schedule
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScheduledTaskRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this scheduled task — remove it. Re-resolve by identity
        // so a concurrent delete makes this a no-op instead of a hard error.
        const live = await findEntityByIdentity(client, IT_SCHEDULED_TASK_ENDPOINTS, entry.taskId)
        if (live?.id) {
          await deleteEntity(client, IT_SCHEDULED_TASK_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this scheduled task — restore the captured prior values.
        const restore: Record<string, unknown> = {
          id: entry.id,
          task_id: entry.taskId,
        }
        if (entry.prior.is_active !== undefined) restore.is_active = entry.prior.is_active
        if (entry.prior.schedule !== undefined) restore.schedule = entry.prior.schedule

        await updateEntity(client, IT_SCHEDULED_TASK_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} scheduled task(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} scheduled task(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
