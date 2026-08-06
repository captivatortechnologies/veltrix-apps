import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getPushEventSettings } from '../../lib/gravityZoneApi'
import { buildPushEventSettingsBody, extractPushEventSettingsSpec, parseServiceSettings, pushEventSettingsMatch } from './_shared'

/**
 * Detect drift for the push event settings singleton: re-fetch
 * push.getPushEventSettings and compare status/serviceType/serviceSettings/
 * subscribeToEventTypes. A getPushEventSettings failure is critical drift; a
 * misconfigured (but present) singleton is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const spec = extractPushEventSettingsSpec(ctx.deployedConfig)
  if (!spec) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await getPushEventSettings(client)
  } catch (error) {
    diffs.push({ field: 'push-event-settings', expected: 'reachable', actual: error instanceof Error ? error.message : 'unreachable', severity: 'critical' })
    return { hasDrift: true, diffs }
  }

  const { value: serviceSettings } = parseServiceSettings(spec)
  if (!pushEventSettingsMatch(spec, serviceSettings, live)) {
    diffs.push({
      field: 'push-event-settings',
      expected: buildPushEventSettingsBody(spec, serviceSettings),
      actual: live,
      severity: 'warning',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
