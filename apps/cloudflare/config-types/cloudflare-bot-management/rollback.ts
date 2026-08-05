import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import type { BotManagementRollbackEntry } from './deploy'
import type { LiveBotManagement } from './validate'

/** Read-only keys Cloudflare reports but never accepts on write. */
const READ_ONLY_KEYS = new Set(['stale_zone_configuration'])

/**
 * Roll back the zone's Bot Management configuration using the full prior
 * object captured during deploy: PUT it back verbatim (minus read-only keys).
 * There is nothing to create or delete — it is a singleton — so rollback is
 * purely restoring the value that was live before the deploy overwrote it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  const rollbackData = ctx.rollbackData as BotManagementRollbackEntry | undefined
  if (!rollbackData?.prior) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  try {
    const restore = stripReadOnly(rollbackData.prior)
    const res = await client.zone('PUT', '/bot_management', { body: restore })
    if (!res.ok) {
      throw new Error(`Failed to restore Bot Management settings: ${cloudflareErrorMessage(res)}`)
    }
    return { success: true, message: `Rolled back Bot Management settings for zone "${domain}"` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

function stripReadOnly(live: LiveBotManagement): Record<string, unknown> {
  const body: Record<string, unknown> = { ...live }
  for (const key of READ_ONLY_KEYS) delete body[key]
  return body
}
