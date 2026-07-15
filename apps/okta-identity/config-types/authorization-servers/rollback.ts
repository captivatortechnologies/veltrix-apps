import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import {
  getAuthServerById,
  isProtectedServerId,
  reconcileAuthServerStatus,
  type AuthServerRollbackEntry,
} from './deploy'

/**
 * Roll back authorization servers using the state captured during deploy:
 *   - servers this deploy CREATED are deleted. Okta will not delete an ACTIVE
 *     authorization server, so each is DEACTIVATED first, then deleted.
 *   - servers this deploy UPDATED are PUT back to their captured prior body,
 *     then returned to their prior lifecycle status.
 *
 * PROTECTED: the Okta-provided default server (id === 'default') is NEVER
 * deleted — a created entry could never carry that id, but the guard is a hard
 * refusal so a rollback can never remove the default server. Rollback is keyed
 * on the server id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuthServerRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this server — remove it. Refuse outright to delete the
        // Okta-provided default server (id 'default'); it is never deleted.
        if (isProtectedServerId(entry.id)) {
          skipped.push(`${entry.name} (Okta default server — not deleted)`)
          continue
        }
        if (entry.id) {
          // DEACTIVATE FIRST: Okta refuses to delete an ACTIVE authorization
          // server. A 404/400 on deactivate means it is already gone or already
          // inactive, which is fine; then delete (404 = already deleted).
          const deactivate = await client.request(
            'POST',
            `/authorizationServers/${entry.id}/lifecycle/deactivate`,
          )
          if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
            throw new Error(
              `Failed to deactivate authorization server "${entry.name}" before delete: ${oktaErrorMessage(deactivate)}`,
            )
          }
          const del = await client.request('DELETE', `/authorizationServers/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete authorization server "${entry.name}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this server — restore its captured prior body, then its
        // prior lifecycle status via the lifecycle endpoints. This is the only
        // path the default server ever takes on rollback (it is updated, never
        // created), so it is restored in place, never deleted.
        const res = await client.request('PUT', `/authorizationServers/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore authorization server "${entry.name}": ${oktaErrorMessage(res)}`)
        }
        const live = await getAuthServerById(client, entry.id)
        await reconcileAuthServerStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    const skipNote = skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} authorization server(s): ${reverted.join(', ')}. Servers created by the deployment were deactivated before deletion (Okta cannot delete an active server).${skipNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} server(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
