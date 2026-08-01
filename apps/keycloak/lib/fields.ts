// =============================================================================
// Shared canvas-field readers for the Keycloak config types.
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

/** Read a checkbox/boolean field, tolerating the "true"/"false"/1/0 string forms. */
export function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

/**
 * Read a tags/list field into a de-duplicated array of trimmed strings. Accepts
 * the `tags` widget's array, or a comma/newline-separated string.
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
