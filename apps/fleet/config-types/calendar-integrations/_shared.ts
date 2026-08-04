// Shared helpers for the Fleet calendar-integrations config type (deploy +
// driftDetect). Manages only the per-team, non-secret half of Fleet's Google
// Calendar integration (integrations.google_calendar: enable_calendar_events +
// webhook_url) via PATCH /api/v1/fleet/fleets/{id} — the global half (the
// domain + service-account API key JSON) is credential material and is out of
// scope for this app; see README "Intentionally excluded".
//
// Fleet's own docs disagree on the shape of `integrations.google_calendar` at
// the team level: the PATCH request schema documents it as an ARRAY of one
// object, but the GET /fleets/{id} response example shows a single OBJECT.
// This module writes the array shape (per the PATCH spec) and reads back
// EITHER shape defensively.
import { getJson, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'

export interface TeamCalendarConfig {
  enable_calendar_events?: boolean
  webhook_url?: string
}

function coerceCalendarConfig(raw: unknown): TeamCalendarConfig {
  if (Array.isArray(raw)) return (raw[0] as TeamCalendarConfig | undefined) ?? {}
  if (raw && typeof raw === 'object') return raw as TeamCalendarConfig
  return {}
}

/** GET a team's live calendar-automation config (best-effort — {} on failure). */
export async function getTeamCalendar(
  base: string,
  headers: Record<string, string>,
  teamId: number,
): Promise<TeamCalendarConfig> {
  try {
    const res = await getJson<{ team?: { integrations?: { google_calendar?: unknown } } }>(
      `${base}${FLEET_API_BASE}/fleets/${teamId}`,
      headers,
    )
    return coerceCalendarConfig(res.team?.integrations?.google_calendar)
  } catch {
    return {}
  }
}

/** PATCH a team's calendar-automation config. */
export async function setTeamCalendar(
  base: string,
  headers: Record<string, string>,
  teamId: number,
  config: TeamCalendarConfig,
): Promise<void> {
  await sendJson('PATCH', `${base}${FLEET_API_BASE}/fleets/${teamId}`, headers, {
    integrations: {
      google_calendar: [{ enable_calendar_events: config.enable_calendar_events ?? false, webhook_url: config.webhook_url ?? '' }],
    },
  })
}
