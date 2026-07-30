import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { findTeamByName, type FleetTeam } from './_shared'

/**
 * Undo a team deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH the prior team fields back, or DELETE the team we created (its
 * prior body was null). Fleet deletes teams by id via DELETE /api/v1/fleet/teams/
 * {id} — the created id isn't in rollbackData, so we re-find it by name first.
 * Verify against a live Fleet (fleetdm) instance.
 */
function priorBody(t: FleetTeam): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description ?? '',
  }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ name: string; team: FleetTeam | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for team rollback' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  try {
    for (const { name, team } of previous) {
      if (team) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/teams/${team.id}`, headers, priorBody(team))
        restored++
      } else {
        const live = await findTeamByName(base, headers, name)
        if (live) {
          await sendJson('DELETE', `${base}${FLEET_API_BASE}/teams/${live.id}`, headers)
          deleted++
        }
      }
    }
    return { success: true, message: `Rolled back teams: ${restored} restored, ${deleted} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
