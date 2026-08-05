import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { buildAppRuleBody, sortAppRules, type AppRuleRollbackEntry } from './deploy'

/**
 * Roll back app rules using the state captured during deploy:
 *   - rules that were created are deleted (DELETE /api/2/apps/{appId}/rules/{id}, tolerate 404)
 *   - rules that were updated are restored (PUT) to their prior writable
 *     state (match/enabled/conditions/actions)
 *   - each affected app's FULL rule order is restored to exactly what it was
 *     before this deploy (`originalOrders[appId]`) via
 *     PUT /api/2/apps/{appId}/rules/sort
 *
 * Never touches a rule this deploy did not create, change, or reorder.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const rollbackData = ctx.rollbackData as
    | { previousState?: AppRuleRollbackEntry[]; originalOrders?: Record<number, number[]> }
    | undefined
  const previousState = rollbackData?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = `${entry.name} (app ${entry.appId})`
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `/api/2/apps/${entry.appId}/rules/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete app rule "${label}": ${oneLoginErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request('PUT', `/api/2/apps/${entry.appId}/rules/${entry.id}`, { body: buildAppRuleBody(entry.prior) })
        if (!res.ok) {
          throw new Error(`Failed to restore app rule "${label}": ${oneLoginErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    if (rollbackData?.originalOrders) {
      for (const [appIdStr, order] of Object.entries(rollbackData.originalOrders)) {
        if (order.length > 0) await sortAppRules(client, Number(appIdStr), order)
      }
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} app rule(s): ${reverted.join(', ')}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} rule(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
