import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getIdpById, reconcileIdpStatus, type IdpRollbackEntry } from './deploy'

/**
 * Roll back identity providers using the state captured during deploy:
 *   - IdPs this deploy CREATED are deleted. Okta requires an IdP to be INACTIVE
 *     before it can be deleted, so each is DEACTIVATED first, then deleted
 *     (deactivate-before-delete). A delete also fails while a routing rule or
 *     policy still references the IdP — that error is surfaced clearly.
 *   - IdPs this deploy UPDATED are PUT back to their captured prior definition,
 *     then returned to their prior lifecycle status.
 *
 * Rollback is keyed on the IdP id Okta returned, never on the name.
 *
 * SENSITIVE / LIMITATION: the write-only client secret
 * (protocol.credentials.client.client_secret) is never returned by Okta, so a
 * restored (UPDATED) OIDC/OAUTH2 IdP has no secret to replay — its federated
 * sign-in may need the secret re-entered. This is called out in the message.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IdpRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  let restoredUpdate = false

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this IdP — remove it. DEACTIVATE FIRST: Okta refuses to
        // delete an ACTIVE IdP. A 404/400 on deactivate means it is already gone
        // or already inactive, which is fine; then delete (404 = already deleted).
        if (entry.id) {
          const deactivate = await client.request('POST', `/idps/${entry.id}/lifecycle/deactivate`)
          if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
            throw new Error(
              `Failed to deactivate IdP "${entry.name}" before delete: ${oktaErrorMessage(deactivate)}`,
            )
          }
          const del = await client.request('DELETE', `/idps/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete IdP "${entry.name}": ${oktaErrorMessage(del)}. Okta will not delete an IdP that is still referenced by a routing rule or policy — remove those references first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this IdP — restore its captured prior definition, then
        // restore its prior lifecycle status via the lifecycle endpoints. The
        // write-only client secret is not in `prior` (Okta never returns it).
        const res = await client.request('PUT', `/idps/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore IdP "${entry.name}": ${oktaErrorMessage(res)}`)
        }
        restoredUpdate = true
        const live = await getIdpById(client, entry.id)
        await reconcileIdpStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    const secretNote = restoredUpdate
      ? ' Restored IdPs may need their client secret re-entered — Okta never returns it, so it could not be replayed.'
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} identity provider(s): ${reverted.join(', ')}. IdPs created by the deployment were deactivated before deletion (Okta cannot delete an active IdP).${secretNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} identity provider(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
