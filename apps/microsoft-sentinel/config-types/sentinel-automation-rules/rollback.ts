import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import type { AutomationRollbackEntry } from './deploy'

/**
 * Roll back automation rules using the state captured during deploy: rules this
 * deploy created are deleted; rules it updated are restored to their prior
 * properties via an unconditional PUT. The captured etag is intentionally NOT
 * sent — this deploy already bumped it, so the prior etag is stale and would
 * fail the service's optimistic-concurrency check.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AutomationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = client.sentinelPath(`/automationRules/${entry.ruleId}`)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete automation rule "${entry.ruleName}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.request('PUT', path, {
          apiVersion: SENTINEL_API_VERSION,
          body: { properties: entry.prior.properties },
        })
        if (!res.ok) throw new Error(`Failed to restore automation rule "${entry.ruleName}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.ruleName)
    }
    return { success: true, message: `Rolled back ${reverted.length} automation rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
