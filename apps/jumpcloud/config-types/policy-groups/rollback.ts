import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, type JumpCloudClient } from '../../lib/jumpcloudApi'
import { buildMemberOp } from './_shared'
import type { PolicyGroupRollbackEntry } from './deploy'

/**
 * Undo a Policy Groups deploy from rollbackData.previousState (written by
 * deploy), per group:
 *   1. reverse the applied membership delta (each added Policy is removed,
 *      each removed Policy is re-added);
 *   2. a group this deploy CREATED is then deleted (DELETE /policygroups/{id};
 *      404 tolerated); a group this deploy UPDATED is restored (PUT) to its
 *      prior managed body (name).
 *
 * Applied over the JumpCloud API v2 (/policygroups).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const previousState = (ctx.rollbackData as { previousState?: PolicyGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const reverted: string[] = []
  try {
    for (const entry of previousState) {
      if (!entry.id) {
        reverted.push(entry.name)
        continue
      }

      for (const policyId of entry.added) await revertMember(client, entry.id, 'remove', policyId, entry.name)
      for (const policyId of entry.removed) await revertMember(client, entry.id, 'add', policyId, entry.name)

      if (!entry.existed) {
        const res = await client.request('DELETE', `/policygroups/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete Policy Group "${entry.name}": ${jumpCloudErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', `/policygroups/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore Policy Group "${entry.name}": ${jumpCloudErrorMessage(res)}`)
      }

      reverted.push(entry.name)
    }

    return { success: true, message: `Rolled back ${reverted.length} Policy Group(s): ${reverted.join(', ')}.` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} group(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

async function revertMember(
  client: JumpCloudClient,
  groupId: string,
  op: 'add' | 'remove',
  policyId: string,
  groupName: string,
): Promise<void> {
  const res = await client.request('POST', `/policygroups/${encodeURIComponent(groupId)}/members`, { body: buildMemberOp(op, policyId) })
  if (res.status !== 404 && !res.ok) {
    throw new Error(`Failed to ${op} member Policy ${policyId} on "${groupName}": ${jumpCloudErrorMessage(res)}`)
  }
}
