import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { updateFileVantage } from '../../lib/filevantageAdapter'
import {
  SCHEDULED_EXCLUSION_ENDPOINTS,
  deleteScheduledExclusion,
  findScheduledExclusionByName,
  type ScheduledExclusionRollbackEntry,
} from './deploy'

/**
 * Roll back FileVantage scheduled exclusions using the state captured during
 * deploy:
 *   - exclusions that were created are deleted
 *   - exclusions that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ScheduledExclusionRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this exclusion — remove it. Re-resolve by identity so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findScheduledExclusionByName(client, entry.policyId, entry.name)
        if (live?.id) {
          await deleteScheduledExclusion(client, entry.policyId, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this exclusion — restore the captured prior values.
        // Fields whose prior value was unset get explicit empty values so a
        // description/scope the deployment added is actually removed.
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          policy_id: entry.policyId,
          timezone: entry.prior.timezone ?? 'UTC',
          processes: entry.prior.processes ?? '',
          users: entry.prior.users ?? '',
          description: entry.prior.description ?? '',
        }
        if (entry.prior.schedule_start) restore.schedule_start = entry.prior.schedule_start
        if (entry.prior.schedule_end) restore.schedule_end = entry.prior.schedule_end
        if (entry.prior.repeated) restore.repeated = entry.prior.repeated

        await updateFileVantage(client, SCHEDULED_EXCLUSION_ENDPOINTS, restore)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} FileVantage scheduled exclusion(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} exclusion(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
