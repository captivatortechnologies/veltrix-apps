// Canvas field coercions shared by validators and handlers.
//
// Older platform clients persisted "" (or null) for an untouched optional
// multiselect / remote-multiselect instead of []. Rows written that way stay
// in the database after the client fix, so every list-valued field is read
// through `asStringList` and treated as empty rather than rejected.

/** Normalize a list-valued canvas field: ""/null/undefined → [], scalar → [scalar]. */
export function asStringList(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v !== '')
  if (typeof value === 'string') return [value]
  return []
}

/** True when the stored value cannot be read as a list at all (object, number, boolean). */
export function isUnreadableList(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false
  return !Array.isArray(value) && typeof value !== 'string'
}
