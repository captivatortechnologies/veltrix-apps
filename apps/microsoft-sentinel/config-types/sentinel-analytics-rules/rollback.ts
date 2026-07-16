import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import type { AnalyticsRollbackEntry } from './deploy'

/**
 * Roll back analytics rules using the state captured during deploy: rules this
 * deploy created are deleted; rules it updated are restored to their prior
 * kind/properties via an unconditional PUT. The captured etag is intentionally
 * NOT sent — this deploy already bumped it, so the prior etag is stale and would
 * fail the service's optimistic-concurrency check.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AnalyticsRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = client.sentinelPath(`/alertRules/${entry.ruleId}`)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete analytics rule "${entry.ruleName}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const body = { kind: entry.prior.kind ?? 'Scheduled', properties: entry.prior.properties }
        const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to restore analytics rule "${entry.ruleName}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.ruleName)
    }
    return { success: true, message: `Rolled back ${reverted.length} analytics rule(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
