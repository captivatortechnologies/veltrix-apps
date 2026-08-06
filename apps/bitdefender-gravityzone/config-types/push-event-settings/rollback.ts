import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { setPushEventSettings } from '../../lib/gravityZoneApi'
import { priorAsBody } from './_shared'
import type { PushEventSettingsRollbackData } from './deploy'

/**
 * Roll back the push event settings singleton using the state captured
 * during deploy: if a configuration existed before this deploy, restore it
 * exactly (push.setPushEventSettings). There is no delete for this resource,
 * so when nothing was previously configured, this applies the closest
 * approximation of "unconfigured" (disabled, jsonRPC, empty settings, no
 * subscribed event types) rather than leaving the deploy's configuration in
 * place.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const data = ctx.rollbackData as PushEventSettingsRollbackData | undefined
  if (!data) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  try {
    if (data.priorConfigured && data.prior) {
      await setPushEventSettings(client, priorAsBody(data.prior))
      return { success: true, message: 'Rolled back push event settings to their prior configuration.' }
    }

    await setPushEventSettings(client, { status: 0, serviceType: 'jsonRPC', serviceSettings: {}, subscribeToEventTypes: [] })
    return {
      success: true,
      message:
        'Push event settings had no prior configuration to restore (there is no delete for this resource) — ' +
        'applied the closest approximation of "unconfigured": disabled, jsonRPC, empty settings, no subscribed event types.',
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
