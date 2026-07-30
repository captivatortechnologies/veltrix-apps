// Shared helpers for the Fleet agent-config (org settings) config type.
//
// This is a SINGLETON — Fleet exposes one org configuration at /api/v1/fleet/
// config, and agent_options carries the org-wide osquery agent options. Verify
// the config shape against a live Fleet (fleetdm) instance.
import { getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/** The (partial) org config Fleet returns from GET /api/v1/fleet/config. */
export interface FleetConfig {
  agent_options?: unknown
  [key: string]: unknown
}

/**
 * Read the live org config (best-effort). Returns null when it can't be read —
 * callers treat that as "no snapshot / skip drift".
 */
export async function getFleetConfig(
  base: string,
  headers: Record<string, string>,
): Promise<FleetConfig | null> {
  try {
    return await getJson<FleetConfig>(`${base}${FLEET_API_BASE}/config`, headers)
  } catch {
    return null
  }
}

/** Parse the agentOptions textarea to a JSON value (throws on invalid JSON). */
export function parseAgentOptions(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  return raw ? JSON.parse(raw) : {}
}

/** Deterministic JSON string (sorted keys) so drift ignores key ordering. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet()
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return null
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(normalize)
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = normalize((v as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return JSON.stringify(normalize(value))
}
