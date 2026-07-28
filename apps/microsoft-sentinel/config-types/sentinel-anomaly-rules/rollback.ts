import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import { anomalyPath, type AnomalyRollbackEntry } from './deploy'

/**
 * Roll back anomaly (ML) analytics settings using the state captured during
 * deploy: settings this deploy created are deleted; settings it updated are
 * restored to their prior kind/properties via an unconditional PUT. The captured
 * etag is intentionally NOT sent — this deploy already bumped it, so the prior
 * etag is stale and would fail the service's optimistic-concurrency check.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AnomalyRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = anomalyPath(client, entry.settingsResourceName)
      if (!entry.existed) {
        // Delete a setting this deploy created.
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete anomaly setting "${entry.name}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Restore the prior state (etag omitted — see the note above).
        const body = { kind: entry.prior.kind ?? 'Anomaly', properties: entry.prior.properties }
        const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to restore anomaly setting "${entry.name}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.name)
    }
    return { success: true, message: `Rolled back ${reverted.length} anomaly setting(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
