// Shared helpers for the Fleet global-policies config type (deploy + driftDetect).
import { getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/** Canvas platform choices — kept in sync with canvas.yaml / validate.ts. */
export const PLATFORMS = new Set(['all', 'linux', 'darwin', 'windows'])

/** A global policy as Fleet returns it from GET /api/v1/fleet/global/policies. */
export interface FleetPolicy {
  id: number
  name: string
  query?: string
  description?: string
  resolution?: string
  platform?: string
  critical?: boolean
}

/** GET /api/v1/fleet/global/policies response shape: { policies: FleetPolicy[] }. */
interface FleetPolicyListResponse {
  policies?: FleetPolicy[]
}

/**
 * Fleet stores a policy's platform as a comma-separated string ('' = all
 * platforms). The canvas offers a single choice, so 'all' maps to ''. Verify
 * multi-platform semantics against a live Fleet (fleetdm) instance.
 */
export function toFleetPlatform(value: unknown): string {
  const s = String(value ?? 'all').trim().toLowerCase()
  return s === 'all' || s === '' ? '' : s
}

/** critical ('yes'/'no' select, or a boolean) → boolean (a Fleet Premium field). */
export function normalizeCritical(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/**
 * Find a global policy by exact name in the live Fleet list (best-effort).
 * Returns null when it does not exist or the list can't be read — callers treat
 * that as "new policy". Fleet has no documented get-by-name, so we list and match.
 */
export async function findPolicyByName(
  base: string,
  headers: Record<string, string>,
  name: string,
): Promise<FleetPolicy | null> {
  try {
    const res = await getJson<FleetPolicyListResponse>(`${base}${FLEET_API_BASE}/global/policies`, headers)
    return (res.policies ?? []).find((p) => p.name === name) ?? null
  } catch {
    return null
  }
}
