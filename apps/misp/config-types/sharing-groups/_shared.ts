// Shared helpers for the MISP Sharing Groups config type (deploy + rollback + drift).
//
// MISP sharing-group shapes follow the 2.4 REST API (/sharing_groups,
// /sharing_groups/add, /sharing_groups/edit/{id}); verify against a live
// MISP 2.4 instance.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP sharing group as returned inside a `{ SharingGroup: {...} }` envelope by /sharing_groups. */
export interface MispSharingGroup {
  id?: number | string
  name?: string
  description?: string
  releasability?: string
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

/** Unwrap MISP's `[{ SharingGroup: {...} }]` list into a flat array of sharing groups. */
export function sharingGroupsFromList(list: unknown): MispSharingGroup[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'SharingGroup' in (row as Record<string, unknown>)
      ? ((row as { SharingGroup: MispSharingGroup }).SharingGroup)
      : (row as MispSharingGroup),
  )
}

/** Find a live sharing group by name (case-insensitive — the stable identity). */
export function findSharingGroup(groups: MispSharingGroup[], name: string): MispSharingGroup | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Build the MISP sharing-group body from canvas fields (wrapped in `{ SharingGroup: {...} }` by callers). */
export function buildSharingGroupFields(fields: Record<string, unknown>): MispSharingGroup {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    releasability: normalizeYesNo(fields.releasable) ? 'yes' : 'no',
  }
}
