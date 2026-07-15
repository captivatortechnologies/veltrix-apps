import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getTrustedOriginById, reconcileTrustedOriginStatus, type TrustedOriginRollbackEntry } from './deploy'

/**
 * Roll back trusted origins using the state captured during deploy:
 *   - origins this deploy CREATED are deleted. Unlike network zones, a trusted
 *     origin can be deleted regardless of its lifecycle status, so no deactivate
 *     step is needed first (a 404 = already deleted, which is fine).
 *   - origins this deploy UPDATED are PUT back to their captured prior body, then
 *     returned to their prior lifecycle status.
 *
 * Rollback is keyed on the trusted origin id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TrustedOriginRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this origin — remove it. A trusted origin can be deleted
        // in any status, so no deactivate step is required (404 = already gone).
        if (entry.id) {
          const del = await client.request('DELETE', `/trustedOrigins/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete trusted origin "${entry.name}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this origin — restore its captured prior body, then
        // restore its prior lifecycle status via the lifecycle endpoints.
        const res = await client.request('PUT', `/trustedOrigins/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore trusted origin "${entry.name}": ${oktaErrorMessage(res)}`)
        }
        const live = await getTrustedOriginById(client, entry.id)
        await reconcileTrustedOriginStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} trusted origin(s): ${reverted.join(', ')}. Origins created by the deployment were deleted; updated origins were restored to their prior definition and status.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} origin(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
