// Shared helpers for the Darktrace Watched-Domains (intel feed) config type —
// deploy + rollback + drift + validate.
//
// The Darktrace intel feed is a flat, append/remove list: GET /intelfeed reads the
// watched entries (with fulldetails=true each entry is an object; without, a bare
// name string), POST /intelfeed adds (addentry/addlist) or removes (removeentry).
// There is NO edit — an entry is added or removed, never mutated in place. Verify
// against a live Darktrace.

/** Canvas fields for one watched entry. */
export interface IntelfeedItemFields {
  entry?: unknown
  source?: unknown
  description?: unknown
  expiry?: unknown
  iagn?: unknown
  hostname?: unknown
}

/** One entry as returned by GET /intelfeed?fulldetails=true. */
export interface IntelfeedEntry {
  name?: string
  source?: string
  description?: string
  expiry?: string
  iagn?: boolean
  hostname?: boolean
  [key: string]: unknown
}

/** Coerce a canvas checkbox / string flag into a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

/** Trim an entry value (domain / IP / hostname); Darktrace stores it verbatim. */
export function normalizeEntry(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Normalize GET /intelfeed into a flat array of entries. The endpoint returns a
 * bare `["evil.com", ...]` array by default and `[{ name, source, ... }]` under
 * fulldetails=true; both land on IntelfeedEntry here.
 */
export function entriesFromList(list: unknown): IntelfeedEntry[] {
  if (!Array.isArray(list)) return []
  return list.map((row) =>
    typeof row === 'string' ? { name: row } : (row && typeof row === 'object' ? (row as IntelfeedEntry) : {}),
  )
}

/** Find a live entry by name, case-insensitively (domains/hostnames are case-insensitive). */
export function findEntry(entries: IntelfeedEntry[], entry: string): IntelfeedEntry | null {
  const e = entry.trim().toLowerCase()
  if (!e) return null
  return entries.find((x) => String(x.name ?? '').trim().toLowerCase() === e) ?? null
}

/**
 * Build the POST /intelfeed body that adds one entry. Only non-empty optional
 * fields are included so Darktrace applies its own defaults for the rest.
 */
export function buildAddBody(fields: IntelfeedItemFields): Record<string, unknown> {
  const body: Record<string, unknown> = { addentry: normalizeEntry(fields.entry) }
  const source = String(fields.source ?? '').trim()
  if (source) body.source = source
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const expiry = String(fields.expiry ?? '').trim()
  if (expiry) body.expiry = expiry
  if (normalizeBool(fields.hostname)) body.hostname = true
  if (normalizeBool(fields.iagn)) body.iagn = true
  return body
}
