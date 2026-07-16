import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage, encodeSafeUrlId } from '../../lib/cyberark'
import { buildPermissionObject } from './validate'
import type { SafeMemberRollbackEntry } from './deploy'

/**
 * Roll back safe members using the state captured during deploy:
 *   - members that were added are removed (DELETE .../Members/{memberName})
 *   - members that were updated are restored (PUT) to their prior permissions
 *     and expiration.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SafeMemberRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      const memberPath = `/Safes/${encodeSafeUrlId(entry.safeUrlId)}/Members/${encodeURIComponent(entry.memberName)}`
      if (!entry.existed) {
        const res = await client.request('DELETE', memberPath)
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to remove member "${entry.label}": ${cyberArkErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', memberPath, {
          body: {
            membershipExpirationDate: entry.prior.membershipExpiration,
            permissions: buildPermissionObject(entry.prior.permissions),
          },
        })
        if (!res.ok) throw new Error(`Failed to restore member "${entry.label}": ${cyberArkErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} safe member(s): ${reverted.join(', ')}` }
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
