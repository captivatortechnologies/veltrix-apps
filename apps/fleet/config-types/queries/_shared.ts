// Shared helpers for the Fleet saved-queries config type (deploy + driftDetect).
import { getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/** Canvas platform choices — kept in sync with canvas.yaml / validate.ts. */
export const PLATFORMS = new Set(['all', 'linux', 'darwin', 'windows'])

/** A saved query as Fleet returns it from GET /api/v1/fleet/queries. */
export interface FleetQuery {
  id: number
  name: string
  query?: string
  description?: string
  interval?: number
  platform?: string
  observer_can_run?: boolean
}

/** GET /api/v1/fleet/queries response shape: { queries: FleetQuery[] }. */
interface FleetQueryListResponse {
  queries?: FleetQuery[]
}

/**
 * Fleet stores a query's platform as a comma-separated string ('' = all
 * platforms). The canvas offers a single choice, so 'all' maps to ''. Verify
 * multi-platform semantics against a live Fleet (fleetdm) instance.
 */
export function toFleetPlatform(value: unknown): string {
  const s = String(value ?? 'all').trim().toLowerCase()
  return s === 'all' || s === '' ? '' : s
}

/** observerCanRun ('yes'/'no' select, or a boolean) → boolean. */
export function normalizeObserverCanRun(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/**
 * Find a saved query by exact name in the live Fleet list (best-effort). Returns
 * null when it does not exist or the list can't be read — callers treat that as
 * "new query". Fleet has no documented get-by-name, so we list and match.
 */
export async function findQueryByName(
  base: string,
  headers: Record<string, string>,
  name: string,
): Promise<FleetQuery | null> {
  try {
    const res = await getJson<FleetQueryListResponse>(`${base}${FLEET_API_BASE}/queries`, headers)
    return (res.queries ?? []).find((q) => q.name === name) ?? null
  } catch {
    return null
  }
}
