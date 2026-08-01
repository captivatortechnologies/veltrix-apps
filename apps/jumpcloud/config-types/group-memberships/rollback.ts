import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, type JumpCloudClient } from '../../lib/jumpcloudApi'
import { buildMemberOp } from './_shared'
import type { MembershipRollbackEntry } from './deploy'

/**
 * Undo a Memberships deploy from rollbackData.previousState (written by deploy) by
 * REVERSING the applied delta per group:
 *   - each user the deploy ADDED is removed again,
 *   - each user the deploy REMOVED is added back,
 * restoring the group's prior membership. A 404 on an op is tolerated (the user or
 * binding is already gone). Applied over the JumpCloud API v2.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: MembershipRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const reverted: string[] = []
  try {
    for (const entry of previousState) {
      for (const userId of entry.added) await revert(client, entry.groupId, 'remove', userId, entry.groupName)
      for (const userId of entry.removed) await revert(client, entry.groupId, 'add', userId, entry.groupName)
      reverted.push(entry.groupName)
    }
    return { success: true, message: `Rolled back membership for ${reverted.length} group(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

async function revert(
  client: JumpCloudClient,
  groupId: string,
  op: 'add' | 'remove',
  userId: string,
  groupName: string,
): Promise<void> {
  const res = await client.request('POST', `/usergroups/${encodeURIComponent(groupId)}/members`, { body: buildMemberOp(op, userId) })
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to ${op} member ${userId} on "${groupName}": ${jumpCloudErrorMessage(res)}`)
  }
}
