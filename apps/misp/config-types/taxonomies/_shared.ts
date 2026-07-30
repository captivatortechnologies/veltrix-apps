// Shared helpers for the MISP Taxonomies config type (deploy + rollback + drift).
//
// MISP taxonomy shapes follow the 2.4 REST API (/taxonomies,
// /taxonomies/enable/{id}, /taxonomies/disable/{id}); verify against a live
// MISP 2.4 instance.

/** Valid taxonomy enable states from the canvas. */
export const TAXONOMY_STATES = new Set(['enabled', 'disabled'])

/** One MISP taxonomy as returned inside a `{ Taxonomy: {...} }` envelope by /taxonomies. */
export interface MispTaxonomy {
  id?: number | string
  namespace?: string
  description?: string
  enabled?: boolean | number | string
  [key: string]: unknown
}

/**
 * `state`/`enabled` may arrive from the canvas as an 'enabled'/'disabled' string
 * or a boolean, or from MISP as a boolean / 1|0 / '1'|'0' — normalize to a boolean.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'enabled' || s === 'true' || s === '1') return true
  return false
}

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ Taxonomy: {...} }]` list into a flat array of taxonomies. */
export function taxonomiesFromList(list: unknown): MispTaxonomy[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Taxonomy' in (row as Record<string, unknown>)
      ? ((row as { Taxonomy: MispTaxonomy }).Taxonomy)
      : (row as MispTaxonomy),
  )
}

/** Find a live taxonomy by namespace (case-insensitive — the stable identity). */
export function findTaxonomy(taxonomies: MispTaxonomy[], namespace: string): MispTaxonomy | null {
  const n = namespace.trim().toLowerCase()
  if (!n) return null
  return taxonomies.find((t) => String(t.namespace ?? '').trim().toLowerCase() === n) ?? null
}
