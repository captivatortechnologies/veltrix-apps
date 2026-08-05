import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import { FUSION_KIND } from './validate'
import type { FusionRollbackEntry } from './deploy'

/**
 * Roll back the Fusion rule using the state captured during deploy: if this
 * deploy created it (the rare case where no Fusion rule existed yet), delete
 * it; if it updated an existing one, restore the prior kind/properties via an
 * unconditional PUT. The captured etag is intentionally NOT sent — the deploy
 * already bumped it, so the prior etag is stale and would fail the service's
 * optimistic-concurrency check.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: FusionRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }
  const entry = previousState[0]

  try {
    const path = client.sentinelPath(`/alertRules/${entry.ruleId}`)
    if (!entry.existed) {
      const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete the Fusion rule: ${armErrorMessage(res)}`)
      }
      return { success: true, message: 'Rolled back the Fusion rule (deleted the rule this deploy created)' }
    }

    if (entry.prior) {
      const body = { kind: entry.prior.kind ?? FUSION_KIND, properties: entry.prior.properties }
      const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body })
      if (!res.ok) throw new Error(`Failed to restore the Fusion rule: ${armErrorMessage(res)}`)
    }
    return { success: true, message: 'Rolled back the Fusion rule to its prior state' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
