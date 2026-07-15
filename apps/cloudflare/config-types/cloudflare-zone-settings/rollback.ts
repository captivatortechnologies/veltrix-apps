import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { ZoneSettingRollbackEntry } from './deploy'

/**
 * Roll back zone settings using the state captured during deploy: each setting
 * whose prior value was read before the update is PATCHed back to that value.
 * Settings are singletons — never created or deleted — so there is nothing to
 * remove; rollback is purely restoring prior values.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ZoneSettingRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      // Only settings we captured a prior value for can be restored; unreadable
      // ones were never changed (the PATCH would have failed the deploy).
      if (entry.existed && entry.priorValue !== undefined) {
        const res = await client.zone('PATCH', `/settings/${entry.settingId}`, { body: { value: entry.priorValue } })
        if (!res.ok) {
          throw new Error(`Failed to restore setting "${entry.label}": ${cloudflareErrorMessage(res)}`)
        }
      }
      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} zone setting(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} setting(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
