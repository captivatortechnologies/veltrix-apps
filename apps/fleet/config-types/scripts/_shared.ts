// Shared helpers for the Fleet scripts-library config type (deploy + driftDetect
// + rollback). Scripts is the one Fleet resource this app manages that has NO
// JSON create/update path — it's multipart/form-data file upload only — so
// this module leans on lib/fleetApi's sendMultipart in addition to getJson.
import { getAllPages, fleetRequest, FLEET_API_BASE } from '../../lib/fleetApi'

/** Canvas script-type choices — kept in sync with canvas.yaml / validate.ts. */
export const SCRIPT_TYPES = new Set(['sh', 'ps1'])

/** A library script as Fleet returns it from GET /api/v1/fleet/scripts. */
export interface FleetScript {
  id: number
  team_id: number | null
  name: string
  created_at?: string
  updated_at?: string
}

interface FleetScriptListResponse {
  scripts?: FleetScript[]
}

/** Team ID text field ('' or undefined → undefined = "Unassigned"). */
export function toTeamId(value: unknown): number | undefined {
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** name + scriptType → the uploaded filename Fleet stores as the script's identity. */
export function toFilename(name: string, scriptType: unknown): string {
  const ext = String(scriptType ?? 'sh').trim().toLowerCase() === 'ps1' ? 'ps1' : 'sh'
  return `${name}.${ext}`
}

/** List every script available to a team scope (best-effort). */
export async function listScriptsForTeam(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
): Promise<FleetScript[]> {
  const query = teamId === undefined ? '' : `?fleet_id=${teamId}`
  try {
    return await getAllPages<FleetScript>(
      `${base}${FLEET_API_BASE}/scripts${query}`,
      headers,
      (page) => (page as FleetScriptListResponse).scripts,
    )
  } catch {
    return []
  }
}

/** Find a script by its uploaded filename within a team scope (best-effort). */
export async function findScriptByFilename(
  base: string,
  headers: Record<string, string>,
  teamId: number | undefined,
  filename: string,
): Promise<FleetScript | null> {
  const scripts = await listScriptsForTeam(base, headers, teamId)
  return scripts.find((s) => s.name === filename) ?? null
}

/** Download a script's raw content (best-effort — null when it can't be read). */
export async function downloadScriptContent(
  base: string,
  headers: Record<string, string>,
  scriptId: number,
): Promise<string | null> {
  try {
    const res = await fleetRequest(`${base}${FLEET_API_BASE}/scripts/${scriptId}?alt=media`, { headers })
    return res.ok ? res.body : null
  } catch {
    return null
  }
}
