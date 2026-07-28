import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconFailure } from '../../lib/falcon'
import {
  addUserGroupMembers,
  deleteUserGroup,
  removeUserGroupMembers,
  updateUserGroup,
  type UserGroupRollbackEntry,
} from './deploy'

/**
 * Roll back MSSP user groups using the state captured during deploy:
 *   - groups this deploy created are deleted (which removes their members)
 *   - groups it updated have their membership delta reversed (remove what was
 *     added, re-add what was removed) and their prior name/description restored
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserGroupRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this group — remove it whole. 404 means it never
        // finished creating or is already gone, which is the desired state.
        if (entry.id) {
          const res = await deleteUserGroup(client, entry.id)
          const failure = res.status === 404 ? null : falconFailure(res)
          if (failure) throw new Error(`Failed to delete user group "${entry.name}": ${failure}`)
        }
      } else if (entry.id) {
        // Reverse the membership delta, then restore the prior fields.
        await removeUserGroupMembers(client, entry.id, entry.memberDelta?.added ?? [])
        await addUserGroupMembers(client, entry.id, entry.memberDelta?.removed ?? [])
        if (entry.prior) {
          await updateUserGroup(client, entry.id, entry.prior.name ?? entry.name, entry.prior.description ?? '')
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} MSSP user group(s): ${reverted.join(', ')}`,
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
