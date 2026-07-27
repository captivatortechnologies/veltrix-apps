import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteExclusion, findExclusion, updateExclusion } from '../../lib/exclusionAdapter'
import { ROLLBACK_COMMENT } from '../ml-exclusions/exclusionShared'
import { IOA_EXCLUSION_ENDPOINTS, type IoaExclusionRollbackEntry } from './deploy'

/**
 * Roll back IOA exclusions using the state captured during deploy:
 *   - exclusions that were created are deleted
 *   - exclusions that were updated are patched back to their prior values
 * Fields whose prior value was unset are restored to empty so a description or
 * pattern name the deployment added is actually removed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IoaExclusionRollbackEntry[] })
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
        const live = await findExclusion(client, IOA_EXCLUSION_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteExclusion(client, IOA_EXCLUSION_ENDPOINTS, live.id, ROLLBACK_COMMENT)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this exclusion — restore the captured prior values.
        await updateExclusion(client, IOA_EXCLUSION_ENDPOINTS, {
          id: entry.id,
          name: entry.name,
          pattern_id: entry.prior.patternId ?? '',
          pattern_name: entry.prior.patternName ?? '',
          description: entry.prior.description ?? '',
          cl_regex: entry.prior.clRegex ?? '',
          ifn_regex: entry.prior.ifnRegex ?? '',
          groups: entry.prior.appliedGlobally ? ['all'] : entry.prior.groups,
          comment: entry.prior.comment ?? ROLLBACK_COMMENT,
        })
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} IOA exclusion(s): ${reverted.join(', ')}`,
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
