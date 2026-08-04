import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient, cyberArkErrorMessage } from '../../lib/cyberark'
import type { VaultUserRollbackEntry } from './deploy'

/**
 * Roll back Vault users using the state captured during deploy:
 *   - users that were created are deleted (DELETE /Users/{id})
 *   - users that were updated are restored (PUT) to their prior non-secret
 *     fields
 *
 * ⚠ SECRET LIMITATION: the initial password is write-only and never
 * captured, so a restored user keeps whatever password it currently has.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: VaultUserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/Users/${encodeURIComponent(entry.id)}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete user "${entry.label}": ${cyberArkErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/Users/${encodeURIComponent(entry.id)}`, { body: entry.prior })
        if (!res.ok) throw new Error(`Failed to restore user "${entry.label}": ${cyberArkErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    await client.logoff()
    return { success: true, message: `Rolled back ${reverted.length} Vault user(s): ${reverted.join(', ')}` }
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
