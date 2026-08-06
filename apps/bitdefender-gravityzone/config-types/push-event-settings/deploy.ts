import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getPushEventSettings, setPushEventSettings, type GzPushEventSettings } from '../../lib/gravityZoneApi'
import { buildPushEventSettingsBody, extractPushEventSettingsSpec, parseServiceSettings, pushEventSettingsMatch } from './_shared'

export interface PushEventSettingsRollbackData {
  priorConfigured: boolean
  prior: GzPushEventSettings | null
}

/**
 * Deploy the GravityZone push event settings singleton. push.setPushEventSettings
 * REPLACES the entire configuration (every field is required), so this
 * always sends the full declared object when it differs from — or nothing
 * was previously configured for — the live tenant-wide singleton.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const spec = extractPushEventSettingsSpec(ctx.canvas)
  if (!spec) return { success: false, message: 'No push event settings declared.' }

  let priorConfigured = true
  let prior: GzPushEventSettings | null = null
  try {
    prior = await getPushEventSettings(client)
  } catch {
    priorConfigured = false
  }

  try {
    const { value: serviceSettings } = parseServiceSettings(spec)
    const alreadyMatches = priorConfigured && prior !== null && pushEventSettingsMatch(spec, serviceSettings, prior)

    if (!alreadyMatches) {
      await setPushEventSettings(client, buildPushEventSettingsBody(spec, serviceSettings))
    }

    return {
      success: true,
      message: alreadyMatches ? 'Push event settings already match the declared configuration.' : 'Applied the push event settings singleton.',
      rollbackData: { priorConfigured, prior } satisfies PushEventSettingsRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Push event settings deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      rollbackData: { priorConfigured, prior } satisfies PushEventSettingsRollbackData,
    }
  }
}
