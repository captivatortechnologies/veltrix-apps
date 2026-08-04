// Shared helpers for the MISP Galaxy Clusters config type (deploy + rollback + drift).
//
// MISP galaxy-cluster shapes follow the 2.4 REST API (/galaxies,
// /galaxy_clusters/index/{galaxyId}, /galaxy_clusters/add/{galaxyId},
// /galaxy_clusters/edit/{id}, /galaxy_clusters/delete/{id},
// /galaxy_clusters/publish/{id}); verify against a live MISP 2.4 instance.
//
// A cluster is one entry WITHIN a galaxy (e.g. galaxy "Threat Actor", cluster
// "APT-Internal-1"). The parent galaxy can be one of MISP's own default galaxies
// (mitre-attack-pattern, ...) or a custom one authored with the separate
// "Galaxies" config type — either way, only the CLUSTER is created/edited here,
// never the galaxy itself.

export const DISTRIBUTIONS = new Set(['0', '1', '2', '3', '4'])

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP galaxy as returned inside a `{ Galaxy: {...} }` envelope by /galaxies. */
export interface MispGalaxyRef {
  id?: number | string
  uuid?: string
  type?: string
  name?: string
}

/** One galaxy-cluster element: a single key/value pair (MISP's `elements` / `GalaxyElement`). */
export interface MispGalaxyClusterElement {
  id?: number | string
  key?: string
  value?: string
}

/** One MISP galaxy cluster as returned inside a `{ GalaxyCluster: {...} }` envelope. */
export interface MispGalaxyCluster {
  id?: number | string
  uuid?: string
  value?: string
  description?: string
  distribution?: number | string
  sharing_group_id?: number | string | null
  authors?: string[]
  galaxy_id?: number | string
  default?: boolean | number | string
  published?: boolean | number | string
  GalaxyElement?: MispGalaxyClusterElement[]
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

/** Unwrap MISP's `[{ Galaxy: {...} }]` list into a flat array of galaxy refs. */
export function galaxiesFromList(list: unknown): MispGalaxyRef[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Galaxy' in (row as Record<string, unknown>)
      ? ((row as { Galaxy: MispGalaxyRef }).Galaxy)
      : (row as MispGalaxyRef),
  )
}

/** Unwrap MISP's `[{ GalaxyCluster: {...} }]` list into a flat array of clusters. */
export function clustersFromList(list: unknown): MispGalaxyCluster[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'GalaxyCluster' in (row as Record<string, unknown>)
      ? ((row as { GalaxyCluster: MispGalaxyCluster }).GalaxyCluster)
      : (row as MispGalaxyCluster),
  )
}

/** Resolve a galaxy reference (uuid, type, or name — case-insensitive) to its live entry. */
export function findGalaxyRef(galaxies: MispGalaxyRef[], ref: string): MispGalaxyRef | null {
  const r = ref.trim().toLowerCase()
  if (!r) return null
  return (
    galaxies.find((g) => String(g.uuid ?? '').toLowerCase() === r) ??
    galaxies.find((g) => String(g.type ?? '').trim().toLowerCase() === r) ??
    galaxies.find((g) => String(g.name ?? '').trim().toLowerCase() === r) ??
    null
  )
}

/** Find a live, non-default cluster by value (case-insensitive — the stable identity within a galaxy). */
export function findCluster(clusters: MispGalaxyCluster[], value: string): MispGalaxyCluster | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  return clusters.find((c) => !normalizeYesNo(c.default) && String(c.value ?? '').trim().toLowerCase() === v) ?? null
}

/** Parse the authors field: comma-separated text into a string array (empty entries dropped). */
export function parseAuthors(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
}

/** Parse the elements textarea: a JSON array of `{ key, value }` objects, or `[]` on blank/invalid input. */
export function parseElements(value: unknown): Array<{ key: string; value: string }> {
  const raw = String(value ?? '').trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e) => e && typeof e === 'object' && 'key' in e && 'value' in e)
      .map((e) => ({ key: String((e as { key: unknown }).key), value: String((e as { value: unknown }).value) }))
  } catch {
    return []
  }
}

/**
 * Build the MISP galaxy-cluster body from canvas fields (wrapped in
 * `{ GalaxyCluster: {...} }` by callers; `galaxy_id` is set separately from the
 * URL path, per MISP's add/edit contract).
 */
export function buildClusterFields(fields: Record<string, unknown>): MispGalaxyCluster {
  const distribution = Number(fields.distribution ?? 0)
  const sharingGroupId = fields.sharing_group_id
  return {
    value: String(fields.value ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    distribution,
    ...(distribution === 4 && sharingGroupId ? { sharing_group_id: Number(sharingGroupId) } : {}),
    authors: parseAuthors(fields.authors),
    elements: JSON.stringify(parseElements(fields.elements)),
  }
}
