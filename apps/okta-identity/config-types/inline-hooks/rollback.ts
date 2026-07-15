import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getInlineHookById, reconcileHookStatus, type InlineHookRollbackEntry } from './deploy'

/**
 * Roll back inline hooks using the state captured during deploy:
 *   - hooks this deploy CREATED are deleted. Okta REFUSES to delete a hook unless
 *     it is INACTIVE, so each is DEACTIVATED first, then deleted (a 404/400 on
 *     deactivate means it is already gone/inactive, which is fine).
 *   - hooks this deploy UPDATED are PUT back to their captured prior definition,
 *     then returned to their prior lifecycle status.
 *
 * Rollback is keyed on the hook id Okta returned, never on the (name, type).
 * NOTE: the channel secret (HTTP authScheme.value / OAUTH clientSecret) is
 * write-only and was never captured, so a restored (updated) hook keeps whatever
 * secret Okta already holds — it cannot be reverted to an older secret.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: InlineHookRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = `${entry.type}:${entry.name}`

      if (!entry.existed) {
        // Deploy created this hook — remove it. DEACTIVATE FIRST: Okta refuses to
        // delete an ACTIVE hook. A 404/400 on deactivate means it is already gone
        // or already inactive, which is fine; then delete (404 = already deleted).
        if (entry.id) {
          const deactivate = await client.request('POST', `/inlineHooks/${entry.id}/lifecycle/deactivate`)
          if (!deactivate.ok && deactivate.status !== 404 && deactivate.status !== 400) {
            throw new Error(
              `Failed to deactivate inline hook "${label}" before delete: ${oktaErrorMessage(deactivate)}`,
            )
          }
          const del = await client.request('DELETE', `/inlineHooks/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(
              `Failed to delete inline hook "${label}": ${oktaErrorMessage(del)}. Okta will not delete a hook still referenced by a policy — remove those references first, then retry the rollback.`,
            )
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this hook — restore its captured prior definition, then
        // restore its prior lifecycle status via the lifecycle endpoints.
        const res = await client.request('PUT', `/inlineHooks/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore inline hook "${label}": ${oktaErrorMessage(res)}`)
        }
        const live = await getInlineHookById(client, entry.id)
        await reconcileHookStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} inline hook(s): ${reverted.join(', ')}. Hooks created by the deployment were deactivated before deletion (Okta cannot delete an active hook).`,
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
