// =============================================================================
// Shared canvas-field readers.
//
// Every config type extracts its spec from `canvas.sections[].fields` — a flat
// record of untyped values coming out of the Configuration Canvas. These pure
// helpers coerce those raw values consistently (trimming strings, tolerating the
// string forms of booleans/numbers a form control can emit) so validate, deploy,
// drift and health all read a field the same way. Kept dependency-free so they
// bundle into every handler cheaply.
// =============================================================================

/** Read a required string field: trimmed, or "" when unset / not a string. */
export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read an optional string field: trimmed non-empty value, or undefined. */
export function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Read a checkbox/boolean field, tolerating the "true"/"false" string forms. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a number field, tolerating a numeric string; undefined when absent/invalid. */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Read a tags/list field into a de-duplicated array of trimmed strings. Accepts
 * either an array (the `tags` widget) or a comma-separated string.
 */
export function readStringArray(value: unknown): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const out: string[] = []
  for (const item of raw) {
    const s = typeof item === 'string' ? item.trim() : ''
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/** Coerce a raw field value to a string (objects/arrays are JSON-stringified). */
function coerceScalar(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Read a keyvalue field into a plain string map. Tolerates the shapes a canvas
 * `keyvalue` control (or an imported config) can emit: an object ({ k: v }), an
 * array of `{ key|name, value }` pairs, or a newline/comma-separated "k=v"
 * string. Blank keys are dropped; later entries win on a key collision.
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
    for (const line of value.split(/[\n,]/)) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        const k = line.slice(0, idx).trim()
        if (k) out[k] = line.slice(idx + 1).trim()
      }
    }
  }
  return out
}
