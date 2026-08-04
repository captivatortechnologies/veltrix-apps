import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { listGroupMemberIds, reconcileMembers } from './deploy'
import type { AccountGroupRollbackEntry } from './deploy'

/**
 * Roll back account groups using the state captured during deploy.
 *
 * ⚠ PARTIAL ROLLBACK — CyberArk's Gen2 AccountGroups API exposes no
 * delete-group endpoint (only members can be removed over REST). This means:
 *   - a group THIS DEPLOY created cannot be deleted — its MEMBERSHIP is
 *     cleared back to empty (best-effort) and the group object itself is
 *     left in PVWA; removing it requires the PVWA UI or the Vault admin CLI.
 *   - a group that already existed has its membership restored to the prior
 *     snapshot (add/remove reversed) — this part IS fully reversible.
 * Every group processed here reports success once its MEMBERSHIP is
 * reconciled; the leftover-group case is called out in the result message.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AccountGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const leftoverGroups: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.groupId) {
        reverted.push(entry.label)
        continue
      }
      const currentIds = await listGroupMemberIds(client, entry.groupId)
      const desiredIds = entry.existed ? entry.priorMemberAccountIds : []
      await reconcileMembers(client, entry.groupId, desiredIds, currentIds)
      if (!entry.existed) leftoverGroups.push(entry.label)
      reverted.push(entry.label)
    }

    await client.logoff()
    const suffix = leftoverGroups.length
      ? ` — NOTE: ${leftoverGroups.length} group object(s) could not be deleted (no REST delete-group endpoint) and remain in PVWA with empty membership: ${leftoverGroups.join(', ')}`
      : ''
    return { success: true, message: `Rolled back ${reverted.length} account group(s): ${reverted.join(', ')}${suffix}` }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
