import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { getTeamCalendar } from './_shared'

/**
 * Drift for calendar integrations: per declared team, compare the enable
 * toggle and webhook URL against the live config. Best-effort — a team that
 * can't be read is skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const teamId = Number(String(item.fields.teamId ?? '').trim())
    if (!Number.isFinite(teamId)) continue

    const expectedEnabled = String(item.fields.enableCalendarEvents ?? 'no').trim().toLowerCase() === 'yes'
    const expectedWebhookUrl = String(item.fields.webhookUrl ?? '').trim()

    const live = await getTeamCalendar(base, headers, teamId)
    if (live.enable_calendar_events !== undefined && live.enable_calendar_events !== expectedEnabled) {
      diffs.push({ field: `team ${teamId}.enableCalendarEvents`, expected: expectedEnabled, actual: live.enable_calendar_events, severity: 'warning' })
    }
    if (expectedEnabled && live.webhook_url !== undefined && live.webhook_url !== expectedWebhookUrl) {
      diffs.push({ field: `team ${teamId}.webhookUrl`, expected: expectedWebhookUrl, actual: live.webhook_url, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
