import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getBehaviorById, reconcileBehaviorStatus, type BehaviorRollbackEntry } from './deploy'

/**
 * Roll back behavior-detection rules using the state captured during deploy:
 *   - behaviors this deploy CREATED are deleted (a 404 means it is already gone).
 *     Okta deletes a behavior regardless of its lifecycle status, so no
 *     deactivate-first dance is needed.
 *   - behaviors this deploy UPDATED are PUT back to their captured prior body,
 *     then returned to their prior lifecycle status via the lifecycle endpoints.
 *
 * Rollback is keyed on the behavior id Okta returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: BehaviorRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this behavior — remove it. A 404 means it is already gone,
        // which is fine.
        if (entry.id) {
          const del = await client.request('DELETE', `/behaviors/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete behavior "${entry.name}": ${oktaErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this behavior — restore its captured prior body, then
        // restore its prior lifecycle status via the lifecycle endpoints.
        const res = await client.request('PUT', `/behaviors/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore behavior "${entry.name}": ${oktaErrorMessage(res)}`)
        }
        const live = await getBehaviorById(client, entry.id)
        await reconcileBehaviorStatus(client, entry.id, live?.status, entry.priorStatus)
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} behavior rule(s): ${reverted.join(', ')}. Behaviors created by the deployment were deleted; updated behaviors were restored to their prior definition and status.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} behavior(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
