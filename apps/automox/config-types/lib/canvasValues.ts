// Generic canvas-value coercion helpers shared by every Automox config type
// (policies, worklets, server-groups). Not Automox-specific — pure parsing of
// the loosely-typed values a canvas field hands a handler.

/** Coerce a checkbox-ish value to a boolean, falling back when absent/unrecognized. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return fallback
}

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim())).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  }
  return []
}

/**
 * Parse a `tags` list of numeric ids into integers; drops anything that is
 * not a clean non-negative integer string (e.g. "2.5" or "-1" is dropped
 * rather than silently truncated/coerced by `parseInt`).
 */
export function intList(value: unknown): number[] {
  return strList(value)
    .filter((v) => /^\d+$/.test(v))
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => Number.isSafeInteger(n))
}

/** Read a canvas value as a trimmed string, or '' when absent. */
export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read a canvas `number` field, returning null when absent/blank/non-numeric. */
export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}
