import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import { indicatorPath, type IndicatorRollbackEntry } from './deploy'

/**
 * Roll back threat intelligence indicators using the state captured during
 * deploy: indicators this deploy created are deleted by their server-assigned
 * name; indicators it updated are restored to their prior properties via an
 * unconditional PUT by name. The captured etag is intentionally NOT sent — this
 * deploy already bumped it, so the prior etag is stale and would fail the
 * service's optimistic-concurrency check.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: IndicatorRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.name) {
        // A create whose response name could not be read — nothing to address.
        skipped.push(entry.displayName)
        continue
      }
      const path = indicatorPath(client, entry.name)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete indicator "${entry.displayName}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior?.properties) {
        // Restore the prior properties verbatim. The etag is a sibling of
        // properties (never inside it), so it is not resent — this deploy already
        // bumped it and a stale etag would fail the concurrency check.
        const body = { kind: 'indicator', properties: entry.prior.properties }
        const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to restore indicator "${entry.displayName}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.displayName)
    }
    const suffix = skipped.length ? ` (${skipped.length} skipped: no captured name)` : ''
    return { success: true, message: `Rolled back ${reverted.length} indicator(s): ${reverted.join(', ')}${suffix}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
