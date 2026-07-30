// Shared helpers for the Fleet labels config type (deploy + driftDetect).
import { getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/** Canvas platform choices — kept in sync with canvas.yaml / validate.ts. */
export const PLATFORMS = new Set(['all', 'linux', 'darwin', 'windows'])

/** A dynamic label as Fleet returns it from GET /api/v1/fleet/labels. */
export interface FleetLabel {
  id: number
  name: string
  description?: string
  query?: string
  platform?: string
}

/** GET /api/v1/fleet/labels response shape: { labels: FleetLabel[] }. */
interface FleetLabelListResponse {
  labels?: FleetLabel[]
}

/**
 * Fleet stores a label's platform as a single string ('' = all platforms). The
 * canvas offers a single choice, so 'all' maps to ''. Verify platform semantics
 * against a live Fleet (fleetdm) instance.
 */
export function toFleetPlatform(value: unknown): string {
  const s = String(value ?? 'all').trim().toLowerCase()
  return s === 'all' || s === '' ? '' : s
}

/**
 * Find a label by exact name in the live Fleet list (best-effort). Returns null
 * when it does not exist or the list can't be read — callers treat that as "new
 * label". Fleet has no documented get-by-name for labels, so we list and match.
 */
export async function findLabelByName(
  base: string,
  headers: Record<string, string>,
  name: string,
): Promise<FleetLabel | null> {
  try {
    const res = await getJson<FleetLabelListResponse>(`${base}${FLEET_API_BASE}/labels`, headers)
    return (res.labels ?? []).find((l) => l.name === name) ?? null
  } catch {
    return null
  }
}
