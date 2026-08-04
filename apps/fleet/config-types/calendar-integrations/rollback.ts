import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { setTeamCalendar } from './_shared'

interface PriorCalendar {
  teamId: number
  prior: { enable_calendar_events?: boolean; webhook_url?: string }
}

/**
 * Undo a calendar-integration deploy from rollbackData.previous (written by
 * deploy()): for each team, PATCH the prior toggle back. Verify against a
 * live Fleet (fleetdm) instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PriorCalendar[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for calendar-integration rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  try {
    for (const { teamId, prior } of previous) {
      await setTeamCalendar(base, headers, teamId, prior)
      restored++
    }
    return { success: true, message: `Restored calendar integration for ${restored} team(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
