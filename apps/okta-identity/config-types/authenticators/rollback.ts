import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import {
  getAuthenticatorById,
  reconcileAuthenticatorStatus,
  type AuthenticatorRollbackEntry,
} from './deploy'
import { isNonDeactivatableKey } from './validate'

/**
 * Roll back authenticators using the state captured during deploy. The Okta
 * Authenticators API has NO DELETE, so:
 *   - an authenticator this deploy CREATED cannot be removed — it is only
 *     DEACTIVATED (the closest possible undo). This is surfaced in the message
 *     so the operator knows the object still exists and must be retired by hand
 *     if that is required. A non-deactivatable key (okta_password — never
 *     created anyway) is left as-is.
 *   - an authenticator this deploy UPDATED is PUT back to its captured prior
 *     body, then returned to its prior lifecycle status.
 *
 * Rollback is keyed on the authenticator id Okta returned, never on the key.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuthenticatorRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const deactivatedOnly: string[] = []

  try {
    // Undo in reverse so later changes are reverted before earlier ones.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Deploy created this authenticator. There is NO DELETE — the strongest
        // possible undo is to DEACTIVATE it. A 404/400 (already gone/inactive)
        // is fine. okta_password can never be created, but guard anyway.
        if (entry.id && !isNonDeactivatableKey(entry.key)) {
          const res = await client.request('POST', `/authenticators/${entry.id}/lifecycle/deactivate`)
          if (!res.ok && res.status !== 404 && res.status !== 400) {
            throw new Error(
              `Failed to deactivate created authenticator "${entry.identity}": ${oktaErrorMessage(res)}`,
            )
          }
          deactivatedOnly.push(entry.identity)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this authenticator — restore its captured prior body,
        // then restore its prior lifecycle status.
        const res = await client.request('PUT', `/authenticators/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore authenticator "${entry.identity}": ${oktaErrorMessage(res)}`)
        }
        const live = await getAuthenticatorById(client, entry.id)
        await reconcileAuthenticatorStatus(client, entry.id, entry.key, live?.status, entry.priorStatus)
      }

      reverted.push(entry.identity)
    }

    const note = deactivatedOnly.length
      ? ` Created authenticators cannot be deleted (the Okta API has no authenticator delete) and were only DEACTIVATED: ${deactivatedOnly.join(', ')}.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} authenticator(s): ${reverted.join(', ')}.${note}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} authenticator(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
