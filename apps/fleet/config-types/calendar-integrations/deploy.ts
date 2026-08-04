import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { getTeamCalendar, setTeamCalendar } from './_shared'

interface PriorCalendar {
  teamId: number
  prior: { enable_calendar_events?: boolean; webhook_url?: string }
}

/**
 * Deploy Fleet's per-team calendar-automation toggle via the REST API:
 *   read (rollback): GET   /api/v1/fleet/fleets/{id}   → snapshot the prior toggle
 *   update:          PATCH /api/v1/fleet/fleets/{id}    with integrations.google_calendar
 *
 * Requires the org-wide Google Calendar integration (domain + service-account
 * key) to already be configured out of band — that half is credential
 * material this app deliberately does not manage (see README). A team whose
 * global integration isn't set up yet will fail here with Fleet's own error.
 *
 * rollbackData records the prior toggle per team so rollback can PATCH it
 * back exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for calendar-integration deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: PriorCalendar[] = []
  const appliedTeams: string[] = []

  try {
    for (const item of items) {
      const teamId = Number(String(item.fields.teamId ?? '').trim())
      if (!Number.isFinite(teamId)) continue

      const prior = await getTeamCalendar(base, headers, teamId)
      previous.push({ teamId, prior })

      const enableCalendarEvents = String(item.fields.enableCalendarEvents ?? 'no').trim().toLowerCase() === 'yes'
      await setTeamCalendar(base, headers, teamId, {
        enable_calendar_events: enableCalendarEvents,
        webhook_url: String(item.fields.webhookUrl ?? '').trim(),
      })
      appliedTeams.push(String(teamId))
    }

    return {
      success: true,
      message: `Applied calendar integration for ${appliedTeams.length} team(s): ${appliedTeams.join(', ') || '(none)'}`,
      artifacts: { appliedTeams },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Calendar-integration deploy failed after ${appliedTeams.length} team(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { appliedTeams },
      rollbackData: { previous },
    }
  }
}
