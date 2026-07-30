// Shared helpers for the Fleet teams config type (deploy + driftDetect).
//
// NOTE: Teams is a Fleet Premium feature — on Fleet Free the /api/v1/fleet/teams
// endpoints return 402/403 and deploy surfaces that as an error. Verify tier
// behaviour against a live Fleet (fleetdm) instance.
import { getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/** A team as Fleet returns it from GET /api/v1/fleet/teams. */
export interface FleetTeam {
  id: number
  name: string
  description?: string
}

/** GET /api/v1/fleet/teams response shape: { teams: FleetTeam[] }. */
interface FleetTeamListResponse {
  teams?: FleetTeam[]
}

/**
 * Find a team by exact name in the live Fleet list (best-effort). Returns null
 * when it does not exist or the list can't be read — callers treat that as "new
 * team". Fleet has no documented get-by-name, so we list and match.
 */
export async function findTeamByName(
  base: string,
  headers: Record<string, string>,
  name: string,
): Promise<FleetTeam | null> {
  try {
    const res = await getJson<FleetTeamListResponse>(`${base}${FLEET_API_BASE}/teams`, headers)
    return (res.teams ?? []).find((t) => t.name === name) ?? null
  } catch {
    return null
  }
}
