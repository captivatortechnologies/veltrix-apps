import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import { listGroupMembers, reconcileGroupMembers } from './deploy'
import type { VaultGroupRollbackEntry } from './deploy'

/**
 * Roll back Vault groups using the state captured during deploy:
 *   - groups that were created are deleted outright (DELETE /UserGroups/{id})
 *   - groups that were updated have their fields + membership restored to
 *     the prior snapshot
 * Unlike Account Groups, UserGroups exposes a full delete endpoint, so this
 * rollback is completely reversible.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: VaultGroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.id) {
        reverted.push(entry.label)
        continue
      }
      if (!entry.existed) {
        const res = await client.request('DELETE', `/UserGroups/${encodeURIComponent(entry.id)}`)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete group "${entry.label}": ${cyberArkErrorMessage(res)}`)
        }
      } else {
        if (entry.prior) {
          const res = await client.request('PUT', `/UserGroups/${encodeURIComponent(entry.id)}`, {
            body: { groupName: entry.prior.groupName, description: entry.prior.description, location: entry.prior.location },
          })
          if (!res.ok) throw new Error(`Failed to restore group "${entry.label}": ${cyberArkErrorMessage(res)}`)
        }
        const currentMembers = await listGroupMembers(client, entry.id)
        const desired = entry.priorMembers
          .filter((m) => m.username || m.memberId)
          .map((m) => ({ memberId: (m.username ?? m.memberId) as string, memberType: (m.memberType as 'vault' | 'domain') ?? 'vault', domainName: m.domainName }))
        await reconcileGroupMembers(client, entry.id, desired, currentMembers)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} Vault group(s): ${reverted.join(', ')}` }
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
