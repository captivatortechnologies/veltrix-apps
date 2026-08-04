// Shared helpers for the MISP Tags config type (deploy + rollback + drift).
//
// MISP tag shapes follow the 2.4 REST API (/tags/index, /tags/add,
// /tags/edit/{id}, /tags/delete/{id}); verify against a live MISP 2.4 instance.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP tag as returned inside a `{ Tag: {...} }` envelope by /tags/index. */
export interface MispTag {
  id?: number | string
  name?: string
  colour?: string
  exportable?: boolean | number | string
  org_id?: number | string
  user_id?: number | string
  hide_tag?: boolean | number | string
  numerical_value?: number | string | null
  local_only?: boolean | number | string
  [key: string]: unknown
}

/** Normalize a yes/no select (or a boolean / 1|0) to a boolean. */
export function normalizeYesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/** Parse an optional numeric field (blank → undefined, matches MISP's `0` = unrestricted default). */
export function normalizeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ Tag: {...} }]` list into a flat array of tags. */
export function tagsFromList(list: unknown): MispTag[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Tag' in (row as Record<string, unknown>)
      ? ((row as { Tag: MispTag }).Tag)
      : (row as MispTag),
  )
}

/** Find a live tag by name (case-insensitive — the stable identity; MISP enforces name uniqueness). */
export function findTag(tags: MispTag[], name: string): MispTag | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return tags.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}

/**
 * Build the MISP tag body from canvas fields (wrapped in `{ Tag: {...} }` by callers).
 * `colour` is OMITTED when left blank so a create lets MISP auto-generate one from the
 * name (TagsController::add()) and an edit leaves the existing colour untouched, rather
 * than forcing an empty string past the NOT NULL `colour` column.
 */
export function buildTagFields(fields: Record<string, unknown>): MispTag {
  const colour = String(fields.colour ?? '').trim()
  const numericalValue = normalizeNumber(fields.numerical_value)
  return {
    name: String(fields.name ?? '').trim(),
    ...(colour ? { colour } : {}),
    exportable: normalizeYesNo(fields.exportable),
    local_only: normalizeYesNo(fields.local_only),
    hide_tag: normalizeYesNo(fields.hide_tag),
    ...(numericalValue !== undefined ? { numerical_value: numericalValue } : {}),
    org_id: normalizeNumber(fields.org_id) ?? 0,
    user_id: normalizeNumber(fields.user_id) ?? 0,
  }
}
