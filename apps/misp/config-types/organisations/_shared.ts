// Shared helpers for the MISP Organisations config type (deploy + rollback + drift).
//
// MISP organisation shapes follow the 2.4 REST API (/organisations,
// /admin/organisations/add, /admin/organisations/edit/{id}); verify against a
// live MISP 2.4 instance.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP organisation as returned inside an `{ Organisation: {...} }` envelope by /organisations. */
export interface MispOrganisation {
  id?: number | string
  name?: string
  description?: string
  nationality?: string
  local?: boolean | number | string
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

/** Unwrap MISP's `[{ Organisation: {...} }]` list into a flat array of organisations. */
export function organisationsFromList(list: unknown): MispOrganisation[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Organisation' in (row as Record<string, unknown>)
      ? ((row as { Organisation: MispOrganisation }).Organisation)
      : (row as MispOrganisation),
  )
}

/** Find a live organisation by name (case-insensitive — the stable identity). */
export function findOrganisation(orgs: MispOrganisation[], name: string): MispOrganisation | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return orgs.find((o) => String(o.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Build the MISP organisation body from canvas fields (wrapped in `{ Organisation: {...} }` by callers). */
export function buildOrganisationFields(fields: Record<string, unknown>): MispOrganisation {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    nationality: String(fields.nationality ?? '').trim(),
    local: normalizeYesNo(fields.local),
  }
}
