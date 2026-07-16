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
