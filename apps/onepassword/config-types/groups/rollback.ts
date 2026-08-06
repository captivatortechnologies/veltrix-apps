import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient } from '../../lib/onePassword'
import { setGroupMembers } from './deploy'
import type { GroupRollbackEntry } from './deploy'

/**
 * Roll back groups using the state captured during deploy:
 *   - groups this deploy CREATED have their membership CLEARED (PATCH
 *     members: []) - the bridge has no confirmed DELETE, so this is the
 *     closest reversible action; the group object itself remains until an
 *     operator removes it by hand if that's truly intended.
 *   - groups this deploy UPDATED have their prior member id set restored
 *     exactly.
 *
 * Never touches a group this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.id) {
        reverted.push(entry.displayName)
        continue
      }
      const restoreIds = entry.existed ? (entry.priorMemberIds ?? []) : []
      await setGroupMembers(client, entry.id, restoreIds, entry.displayName)
      reverted.push(entry.displayName)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} group(s): ${reverted.join(', ')}. Groups created by the deploy had their membership cleared, not deleted (see README.md Coverage).`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
