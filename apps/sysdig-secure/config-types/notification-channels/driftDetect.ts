import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { buildChannelBody, findChannelByName, normalizeBoolean } from './_shared'

/**
 * Drift for notification channels: compare presence, `enabled` and the type's
 * primary destination field (url / channel / emailRecipients / snsTopicARNs)
 * against the live channel. Best-effort — a channel that can't be read is
 * skipped rather than raising false drift. Read-only: GET
 * /api/notificationChannels.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live
  try {
    live = await client.listNotificationChannels()
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const enabled = normalizeBoolean(item.fields.enabled, true)
    const channel = findChannelByName(live, name)

    if (!enabled) {
      if (channel) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!channel) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    if (channel.enabled === false) {
      diffs.push({ field: `${name}.enabled`, expected: true, actual: false, severity: 'warning' })
    }

    const expectedOptions = buildChannelBody(item.fields).options
    for (const key of ['url', 'channel'] as const) {
      const expected = expectedOptions[key]
      const actual = channel.options?.[key]
      if (expected && actual !== undefined && expected !== actual) {
        diffs.push({ field: `${name}.${key}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
