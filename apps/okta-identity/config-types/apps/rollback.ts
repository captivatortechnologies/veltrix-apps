import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { associateAccessPolicy, getAppById, reconcileAppStatus, type AppRollbackEntry } from './deploy'

/**
 * Roll back application instances using the state captured during deploy:
 *   - Apps this deploy CREATED are deleted. Okta requires an app to be INACTIVE
 *     before it can be deleted, so each is DEACTIVATED first, then deleted
 *     (deactivate-before-delete).
 *   - Apps this deploy UPDATED are PUT back to their captured prior definition,
 *     returned to their prior lifecycle status, and (if feasible) re-associated
 *     with their prior ACCESS_POLICY.
 *
 * Rollback is keyed on the app id Okta returned, never on the label.
 *
 * WRITE-ONLY / LIMITATION: the credentials secrets (oauthClient.client_secret,
 * signing.*, x5c) are never returned by Okta, so a restored (UPDATED) app has no
 * secret to replay — its client secret / signing key may need re-entering. This
 * is called out in the message.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AppRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  let restoredUpdate = false

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this app — remove it. DEACTIVATE FIRST: Okta refuses to
        // delete an ACTIVE app. A 404/400 on deactivate means it is already gone
        // or already inactive, which is fine; then delete (404 = already deleted).
        if (entry.id) {
          const deactivate = await client.request('POST', `/apps/${entry.id}/lifecycle/deactivate`)
          if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
            throw new Error(
              `Failed to deactivate app "${entry.label}" before delete: ${oktaErrorMessage(deactivate)}`,
            )
          }
          const del = await client.request('DELETE', `/apps/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete app "${entry.label}": ${oktaErrorMessage(del)}. Okta will not delete an app that is still active or referenced — remove those references first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this app — restore its captured prior definition, then
        // restore its prior lifecycle status and access policy. The write-only
        // credentials secrets are not in `prior` (Okta never returns them).
        const res = await client.request('PUT', `/apps/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore app "${entry.label}": ${oktaErrorMessage(res)}`)
        }
        restoredUpdate = true
        const live = await getAppById(client, entry.id)
        await reconcileAppStatus(client, entry.id, live?.status, entry.priorStatus)
        // Re-associate the prior access policy where one was captured. Best-effort
        // — a failure here should not abort the rest of the rollback.
        if (entry.priorAccessPolicyId) {
          try {
            await associateAccessPolicy(client, entry.id, entry.priorAccessPolicyId)
          } catch {
            // Prior policy may have been deleted or requires OIE — leave as-is.
          }
        }
      }

      reverted.push(entry.label)
    }

    const secretNote = restoredUpdate
      ? ' Restored apps may need their client secret / signing key re-entered — Okta never returns those, so they could not be replayed.'
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} application(s): ${reverted.join(', ')}. Apps created by the deployment were deactivated before deletion (Okta cannot delete an active app).${secretNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
