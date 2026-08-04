// Shared helpers for the Sysdig Secure Posture Zone Assignments config type
// (validate + deploy + rollback + drift).
//
// Shape follows the Sysdig Secure /api/cspm/v1/zones/{zoneId}/policies API
// (confirmed against terraform-provider-sysdig's v2 client + resource docs —
// "Each zone can have at most one assignment. Updating the resource replaces
// the entire policy list (PUT semantics).").

export interface ZoneAssignmentFields {
  zoneName?: unknown
  enabled?: unknown
  policyNames?: unknown
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

/** Split a comma/newline separated value (or array) into trimmed strings, preserving order. */
export function splitOrderedList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}
