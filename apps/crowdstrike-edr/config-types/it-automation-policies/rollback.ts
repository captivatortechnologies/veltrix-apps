import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity, findEntityByIdentity, updateEntity } from '../../lib/entityAdapter'
import {
  IT_POLICY_ENDPOINTS,
  assignPolicyHostGroups,
  type ITPolicyRollbackEntry,
} from './deploy'

/**
 * Roll back IT automation policies using the state captured during deploy:
 *   - policies that were created are deleted
 *   - policies that were updated are patched back to their prior description,
 *     enablement and config, and any host-group change is reversed to the
 *     captured prior list
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ITPolicyRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this policy — remove it. Re-resolve by identity so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findEntityByIdentity(client, IT_POLICY_ENDPOINTS, entry.name)
        if (live?.id) {
          await deleteEntity(client, IT_POLICY_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this policy — restore the captured prior values.
        const restore: Record<string, unknown> = {
          id: entry.id,
          name: entry.name,
          description: entry.prior.description ?? '',
        }
        if (entry.prior.enabled !== undefined) restore.is_enabled = entry.prior.enabled
        if (entry.prior.config !== undefined) restore.config = entry.prior.config

        await updateEntity(client, IT_POLICY_ENDPOINTS, restore)

        // Reverse the host-group assignment only when this deploy changed it.
        if (entry.prior.hostGroupsChanged && entry.prior.hostGroups !== undefined) {
          await assignPolicyHostGroups(client, entry.name, entry.id, entry.prior.hostGroups)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} IT automation policy(ies): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} policy(ies): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
