import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getNotificationsSettings } from '../../lib/gravityZoneApi'
import { buildNotificationSettingsBody, declaredLiveSnapshot, extractNotificationSettingsSpecs, notificationSettingsMatch, parseNotificationsSettings } from './_shared'

/**
 * Detect drift for notification settings declarations: re-fetch
 * accounts.getNotificationsSettings per declared accountId and compare every
 * field the canvas declared. A getNotificationsSettings failure (e.g. an
 * invalid accountId) is critical drift; a changed declared field is a
 * warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractNotificationSettingsSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const label = spec.accountId || '(own account)'
    let live
    try {
      live = await getNotificationsSettings(client, spec.accountId || undefined)
    } catch (error) {
      diffs.push({ field: label, expected: 'reachable', actual: error instanceof Error ? error.message : 'unreachable', severity: 'critical' })
      continue
    }

    const { value: notificationsSettings } = parseNotificationsSettings(spec)
    if (!notificationSettingsMatch(spec, notificationsSettings, live)) {
      const expected = buildNotificationSettingsBody(spec, notificationsSettings)
      delete expected.accountId
      diffs.push({ field: `${label}.preferences`, expected, actual: declaredLiveSnapshot(spec, live), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
