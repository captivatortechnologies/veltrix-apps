import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { IdentityProviderRollbackEntry } from './deploy'

/**
 * Roll back identity providers using the state captured during deploy:
 *   - providers this deploy CREATED are deleted. A 404 means it is already
 *     gone, which is fine.
 *   - providers this deploy UPDATED are PUT back to their captured prior body.
 *
 * SENSITIVE / LIMITATION: every secret field (client secret, app secret,
 * Apple's signing key) is write-only - PingOne never returns it, so a
 * restored (UPDATED) provider has no secret to replay. Its federated sign-in
 * may need the secret re-entered; this is called out in the result message.
 *
 * Rollback is keyed on the identity-provider id PingOne returned, never on
 * the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IdentityProviderRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  let restoredUpdate = false

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this provider - remove it.
        if (entry.id) {
          const del = await client.request('DELETE', `/identityProviders/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete identity provider "${entry.name}": ${pingOneErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this provider - restore its captured prior body. The
        // write-only secret fields are not in `prior` (PingOne never returns them).
        const res = await client.request('PUT', `/identityProviders/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore identity provider "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
        restoredUpdate = true
      }

      reverted.push(entry.name)
    }

    const secretNote = restoredUpdate
      ? ' Restored providers may need their client secret, app secret or signing key re-entered - PingOne never returns it, so it could not be replayed.'
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} identity provider(s): ${reverted.join(', ')}.${secretNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
