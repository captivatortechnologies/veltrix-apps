import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getEventHookById, reconcileHookStatus, type EventHookRollbackEntry } from './deploy'

/**
 * Roll back event hooks using the state captured during deploy:
 *   - hooks this deploy CREATED are deleted. Okta will NOT delete an ACTIVE event
 *     hook, so each is DEACTIVATED first, then deleted.
 *   - hooks this deploy UPDATED are PUT back to their captured prior definition,
 *     then returned to their prior lifecycle status.
 *
 * LIMITATION — the auth header value is a WRITE-ONLY secret Okta never returns, so
 * the captured prior definition of an UPDATED hook does NOT carry it. Restoring
 * that prior leaves the hook without its previous secret; the operator must
 * re-enter it. Restoring the channel also clears verification, so a restored hook
 * needs re-verifying (an external handshake this app never performs).
 *
 * Rollback is keyed on the hook id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: EventHookRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this hook — remove it. DEACTIVATE FIRST: Okta refuses to
        // delete an ACTIVE event hook. A 404/400 on deactivate means it is already
        // gone or already inactive, which is fine; then delete (404 = already gone).
        if (entry.id) {
          const deactivate = await client.request('POST', `/eventHooks/${entry.id}/lifecycle/deactivate`)
          if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
            throw new Error(
              `Failed to deactivate event hook "${entry.name}" before delete: ${oktaErrorMessage(deactivate)}`,
            )
          }
          const del = await client.request('DELETE', `/eventHooks/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete event hook "${entry.name}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this hook — restore its captured prior definition, then
        // restore its prior lifecycle status via the lifecycle endpoints. The
        // write-only auth secret cannot be restored (never readable) — see above.
        const res = await client.request('PUT', `/eventHooks/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(
            `Failed to restore event hook "${entry.name}": ${oktaErrorMessage(res)}. The auth header value is a write-only secret Okta never returns, so it cannot be replayed — re-enter it and re-verify the hook if the restore was rejected.`,
          )
        }
        const live = await getEventHookById(client, entry.id)
        await reconcileHookStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} event hook(s): ${reverted.join(', ')}. Hooks created by the deployment were deactivated before deletion (Okta cannot delete an active hook); restored hooks need re-verification and, where the auth secret was replaced, the secret re-entered.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} hook(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
