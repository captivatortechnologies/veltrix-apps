import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteExclusion, findExclusion, updateExclusion } from '../../lib/exclusionAdapter'
import { ROLLBACK_COMMENT } from '../ml-exclusions/exclusionShared'
import { SV_EXCLUSION_ENDPOINTS, type SvExclusionRollbackEntry } from './deploy'

/**
 * Roll back sensor visibility exclusions using the state captured during deploy:
 *   - exclusions that were created are deleted
 *   - exclusions that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SvExclusionRollbackEntry[] })
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
        const live = await findExclusion(client, SV_EXCLUSION_ENDPOINTS, entry.value)
        if (live?.id) {
          await deleteExclusion(client, SV_EXCLUSION_ENDPOINTS, live.id, ROLLBACK_COMMENT)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this exclusion — restore the captured prior values.
        await updateExclusion(client, SV_EXCLUSION_ENDPOINTS, {
          id: entry.id,
          value: entry.value,
          groups: entry.prior.appliedGlobally ? ['all'] : entry.prior.groups,
          comment: entry.prior.comment ?? ROLLBACK_COMMENT,
        })
      }

      reverted.push(entry.value)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} sensor visibility exclusion(s): ${reverted.join(', ')}`,
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
