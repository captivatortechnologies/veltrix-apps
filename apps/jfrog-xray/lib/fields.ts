// =============================================================================
// Shared canvas-field readers for the JFrog Xray config types.
//
// Every config type pulls its spec out of `canvas.items[].fields` — a flat record
// of untyped values the Configuration Canvas emits. These pure, dependency-free
// helpers coerce those raw values the same way across validate / deploy / drift so
// a field is never read two ways. Kept network-free so they bundle cheaply into
// every handler (and into the app tests, which run them directly).
// =============================================================================

/** Read a string field: trimmed, or "" when unset / not a string. */
export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read an optional string field: trimmed non-empty value, or undefined. */
export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Read a checkbox-ish field, tolerating the boolean / 'true' / 'false' string forms. */
export function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a number field, tolerating the numeric-string form. Returns undefined when absent/invalid. */
export function readOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read a `tags`/list field into a de-duplicated array of trimmed strings.
 * Accepts the `tags` widget's array or a comma/newline-separated string.
 */
export function readStringArray(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\r\n,]+/)
      : []
  const out: string[] = []
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * Read a `textarea` field holding a JSON object. Accepts an already-parsed
 * object, or a JSON string. A blank value is an empty object. Returns a
 * discriminated result so callers can surface a precise validation error.
 */
export function parseJsonObject(
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: {} }
  if (Array.isArray(value)) return { ok: false, error: 'must be a JSON object, not an array' }
  if (typeof value === 'object') return { ok: true, value: value as Record<string, unknown> }
  if (typeof value !== 'string') return { ok: false, error: 'must be a JSON object' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/**
 * Read a `textarea` field holding a JSON array. Accepts an already-parsed
 * array, or a JSON string. A blank value is an empty array.
 */
export function parseJsonArray(
  value: unknown,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: [] }
  if (Array.isArray(value)) return { ok: true, value }
  if (typeof value !== 'string') return { ok: false, error: 'must be a JSON array' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' }
  return { ok: true, value: parsed }
}

/** Two string lists are equal as sets (order-insensitive, assumes de-duped). */
export function stringSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

/** A loose (not RFC-5322-exhaustive) email shape check — enough to catch typos. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}
