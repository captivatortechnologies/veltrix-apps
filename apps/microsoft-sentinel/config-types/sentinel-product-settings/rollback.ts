import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage } from '../../lib/sentinel'
import { SENTINEL_SETTINGS_API_VERSION } from './validate'
import type { ProductSettingRollbackEntry } from './deploy'

/**
 * Roll back product settings using the state captured during deploy. These are
 * fixed-name singletons, so rollback is restore-only: a setting this deploy
 * updated is restored to its prior kind/properties via an unconditional PUT. A
 * setting that had not materialised before the deploy is left as-is — a product
 * setting is NEVER deleted on rollback. The captured etag is intentionally not
 * sent (the deploy already bumped it, so the prior etag is stale).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProductSettingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed || !entry.prior) {
        // No prior value to restore, and product settings are never deleted.
        skipped.push(entry.setting)
        continue
      }
      const path = client.sentinelPath(`/settings/${entry.setting}`)
      const body = { kind: entry.prior.kind ?? entry.setting, properties: entry.prior.properties }
      const res = await client.request('PUT', path, { apiVersion: SENTINEL_SETTINGS_API_VERSION, body })
      if (!res.ok) throw new Error(`Failed to restore product setting "${entry.setting}": ${armErrorMessage(res)}`)
      reverted.push(entry.setting)
    }
    const skippedNote = skipped.length ? ` (${skipped.length} left as-is: ${skipped.join(', ')})` : ''
    return { success: true, message: `Rolled back ${reverted.length} product setting(s): ${reverted.join(', ') || 'none'}${skippedNote}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
