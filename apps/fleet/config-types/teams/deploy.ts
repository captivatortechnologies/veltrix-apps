import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, sendJson, FLEET_API_BASE } from '../../lib/fleetApi'
import { findTeamByName, type FleetTeam } from './_shared'

/**
 * Deploy Fleet teams via the REST API, upserting by name:
 *   read (rollback): GET   /api/v1/fleet/teams        → find by name (best-effort — miss = new team)
 *   create:          POST  /api/v1/fleet/teams        with the team body
 *   update:          PATCH /api/v1/fleet/teams/{id}   when the name already exists
 *
 * Canvas → Fleet mapping (per team):
 *   name        → name
 *   description → description
 *
 * Teams is a Fleet Premium feature — on Fleet Free these endpoints return 402/403
 * and the deploy fails with that HTTP error. rollbackData records the prior team
 * per name (null when it did not exist) so rollback can PATCH it back or DELETE
 * the one we created. Verify the request bodies against a live Fleet (fleetdm)
 * instance.
 */
function buildTeamBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for team deployment' }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; team: FleetTeam | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = await findTeamByName(base, headers, name)
      previous.push({ name, team: existing })

      const body = buildTeamBody(item.fields)
      if (existing) {
        await sendJson('PATCH', `${base}${FLEET_API_BASE}/teams/${existing.id}`, headers, body)
      } else {
        await sendJson('POST', `${base}${FLEET_API_BASE}/teams`, headers, body)
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} team(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Team deploy failed after ${applied.length} team(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
