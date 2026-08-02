// Small value-coercion helpers shared by the Graylog config types that were
// added after streams (inputs / pipeline-rules / index-sets). Kept generic here
// so each config type parses canvas fields the same way. streams keeps its own
// copies to stay self-contained.

/** Coerce a checkbox / boolean-ish value to a boolean. */
export function toBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

/** Trim a value to a string ('' for null/undefined). */
export function asString(value: unknown): string {
  return String(value ?? '').trim()
}

/** Parse an integer, falling back when the value is absent or unparseable. */
export function toInt(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback
  const n = parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

export interface ParsedObject {
  value: Record<string, unknown>
  error?: string
}

/**
 * Parse a canvas field that carries a JSON object. Accepts an already-parsed
 * object (defensive) or a JSON string. Blank is a valid empty object. Returns a
 * structured error (rather than throwing) so validate() can surface it cleanly.
 */
export function parseJsonObject(value: unknown): ParsedObject {
  if (value == null || value === '') return { value: {} }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { value: {} }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { value: {}, error: `not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: {}, error: 'must be a JSON object' }
  }
  return { value: raw as Record<string, unknown> }
}
