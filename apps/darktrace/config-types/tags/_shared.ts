// Shared helpers for the Darktrace Tags config type — deploy + rollback + drift + validate.
//
// Darktrace tags are named labels used to group entities and drive model logic.
// GET /tags lists them ({ tid, name, color, description }); POST /tags creates one
// by name (with an optional HSL-hue colour and description); DELETE /tags/{tid}
// removes one by its numeric id. Like the intel feed there is NO edit — a tag is
// created or deleted, never mutated in place. The tag NAME is the stable identity
// for authoring; the numeric `tid` is Darktrace's handle used to delete. Verify the
// create-response shape (whether it returns the new tid) against a live Darktrace.

/** Canvas fields for one tag. */
export interface TagItemFields {
  name?: unknown
  color?: unknown
  description?: unknown
}

/** One tag as returned by GET /tags. */
export interface DarktraceTag {
  tid?: number | string
  name?: string
  color?: number
  description?: string
  [key: string]: unknown
}

/** Trim a tag name; Darktrace stores it verbatim. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Coerce a canvas number / string into an integer HSL hue, or null when the value
 * is absent, blank or not a finite number (callers omit colour when this is null).
 */
export function normalizeColor(value: unknown): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Normalize GET /tags into a flat array. Accepts a bare `[{ tid, name, ... }]`
 * array and a `{ tags: [...] }` envelope; both land on DarktraceTag here.
 */
export function tagsFromList(list: unknown): DarktraceTag[] {
  const rows = Array.isArray(list)
    ? list
    : list && typeof list === 'object' && Array.isArray((list as { tags?: unknown }).tags)
      ? ((list as { tags: unknown[] }).tags)
      : []
  return rows.map((row) => (row && typeof row === 'object' ? (row as DarktraceTag) : {}))
}

/** Find a live tag by name, case-insensitively (tag names match case-insensitively). */
export function findTag(tags: DarktraceTag[], name: string): DarktraceTag | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return tags.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}

/**
 * Extract a numeric tid from a create response, tolerating the shapes seen across
 * Darktrace builds: a bare number, a `{ tid }` (or `{ id }`) object, or a
 * single-element array wrapping either. Returns null when none is present.
 */
export function tidFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.trim() && Number.isFinite(Number(value)) ? Number(value) : null
  if (Array.isArray(value)) return value.length ? tidFrom(value[0]) : null
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if ('tid' in o) return tidFrom(o.tid)
    if ('id' in o) return tidFrom(o.id)
  }
  return null
}

/**
 * Build the POST /tags body that creates one tag. Only non-empty optional fields
 * are included so Darktrace applies its own default for the rest (e.g. colour).
 */
export function buildCreateBody(fields: TagItemFields): Record<string, unknown> {
  const body: Record<string, unknown> = { name: normalizeName(fields.name) }
  const color = normalizeColor(fields.color)
  if (color !== null) body.color = color
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  return body
}
