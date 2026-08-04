// =============================================================================
// Shared canvas-field readers for the Auth0 config types.
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

/**
 * Read a tags/list/textarea field into a de-duplicated array of trimmed strings.
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

/** Read an optional integer field, tolerating the numeric-string form. */
export function readOptionalInt(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) return undefined
  return Math.trunc(n)
}

/** Coerce a raw keyvalue entry to a string (objects/arrays are JSON-stringified). */
function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Read a `keyvalue` field into a plain string map. Tolerates the shapes the canvas
 * control (or an imported config) can emit: an object ({ k: v }), an array of
 * `{ key|name, value }` pairs, or a newline/comma-separated "k=v" string. Blank
 * keys are dropped; later entries win on a key collision.
 */
export function readKeyValueMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = readString(rec.key ?? rec.name)
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
    return out
  }
  if (typeof value === 'string' && value.trim()) {
    for (const line of value.split(/[\r\n,]+/)) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) out[k] = line.slice(idx + 1).trim()
      }
    }
  }
  return out
}

/**
 * Read a `textarea`/`keyvalue` field holding a JSON object. Accepts an already
 * parsed object, or a JSON string. A blank value is an empty object. Returns a
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

/** Two string maps are equal when they hold the same keys and values. */
export function stringMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => b[k] === a[k])
}

/** Two string lists are equal as sets (order-insensitive, assumes de-duped). */
export function stringSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

/**
 * Key pattern for values Auth0 returns masked, redacted, or omitted entirely on
 * read: secrets, passwords, private keys, certs, API keys and write keys. Shared
 * across every config type that authors a provider-/strategy-shaped object
 * (connection `options`, log-stream `sink`, email-provider `credentials`, …) so a
 * live secret is never diffed for drift or replayed by a rollback restore.
 */
export const SECRET_LIKE_KEY = /secret|password|_pass\b|private|_key$|api_?key|token|cert|connection_string/i

/** Drop secret-bearing keys from an object (Auth0 returns them masked or omits them). */
export function stripSecretKeys<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!SECRET_LIKE_KEY.test(key)) (out as Record<string, unknown>)[key] = value
  }
  return out
}
