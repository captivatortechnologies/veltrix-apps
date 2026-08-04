// Shared helpers for the MISP Galaxies config type (deploy + rollback + drift).
//
// MISP galaxy shapes follow the 2.4 REST API (/galaxies, /galaxies/add,
// /galaxies/edit/{id}, /galaxies/delete/{id}, /galaxies/enable/{id},
// /galaxies/disable/{id}); verify against a live MISP 2.4 instance.
//
// A "galaxy" is a custom taxonomy CATEGORY (e.g. a new "Internal Threat Actors"
// classification) — the individual entries within it are galaxy CLUSTERS, a
// separate config type (galaxy-clusters). MISP's own default/library galaxies
// (mitre-attack-pattern, ...) are excluded from matching here via `default`.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP galaxy as returned inside a `{ Galaxy: {...} }` envelope by /galaxies. */
export interface MispGalaxy {
  id?: number | string
  uuid?: string
  name?: string
  type?: string
  description?: string
  version?: number | string
  icon?: string
  namespace?: string
  enabled?: boolean | number | string
  local_only?: boolean | number | string
  kill_chain_order?: string | null
  default?: boolean | number | string
  [key: string]: unknown
}

/** Normalize a yes/no select (or a boolean / 1|0) to a boolean. */
export function normalizeYesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ Galaxy: {...} }]` list into a flat array of galaxies. */
export function galaxiesFromList(list: unknown): MispGalaxy[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Galaxy' in (row as Record<string, unknown>)
      ? ((row as { Galaxy: MispGalaxy }).Galaxy)
      : (row as MispGalaxy),
  )
}

/**
 * Find a live CUSTOM galaxy by its `type` (case-insensitive — the stable identity;
 * MISP does not enforce `type` uniqueness at the DB level, only convention, so the
 * first match wins — see the README caveat). MISP's own default/library galaxies
 * (`default: true`) are never matched — this type only manages custom galaxies and
 * must never touch the library MISP ships (mitre-attack-pattern, ...).
 */
export function findGalaxy(galaxies: MispGalaxy[], type: string): MispGalaxy | null {
  const t = type.trim().toLowerCase()
  if (!t) return null
  return galaxies.find((g) => !normalizeYesNo(g.default) && String(g.type ?? '').trim().toLowerCase() === t) ?? null
}

/** Build the MISP galaxy body from canvas fields (wrapped in `{ Galaxy: {...} }` by callers). */
export function buildGalaxyFields(fields: Record<string, unknown>): MispGalaxy {
  const killChainOrder = String(fields.kill_chain_order ?? '').trim()
  const icon = String(fields.icon ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    type: String(fields.type ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    namespace: String(fields.namespace ?? '').trim() || 'custom',
    ...(icon ? { icon } : {}),
    local_only: normalizeYesNo(fields.local_only),
    ...(killChainOrder ? { kill_chain_order: killChainOrder } : {}),
  }
}
