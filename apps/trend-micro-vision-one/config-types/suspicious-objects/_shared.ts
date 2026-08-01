// Shared helpers for the Trend Vision One User-Defined Suspicious Object List
// config type (deploy + rollback + drift).
//
// Endpoint paths + body/field shapes below follow the Trend Vision One public API
// v3.0 (Threat Intelligence -> Suspicious Object management). The add + list paths
// are CONFIRMED; the delete path is inferred from v3.0 `/delete` sub-resource
// conventions and is FLAGGED — VERIFY it against a live Vision One tenant.

// --- Trend Vision One suspicious-object endpoints ----------------------------
// All hang off /v3.0 (added by the client). See lib/visionOneApi.ts.
export const SUSPICIOUS_OBJECT_ENDPOINTS = {
  /** List suspicious objects. GET; returns { items: [...], nextLink }. CONFIRMED. */
  list: '/threatintel/suspiciousObjects',
  /** Add/update suspicious objects. POST; body is an ARRAY of objects. CONFIRMED. */
  add: '/threatintel/suspiciousObjects',
  /** Remove suspicious objects. POST; body is an ARRAY of { <type>: value }. FLAGGED — VERIFY. */
  delete: '/threatintel/suspiciousObjects/delete',
} as const

/**
 * Accepted object types. Each maps 1:1 to the identifier field name the Vision One
 * v3.0 API expects in the request/response body (e.g. type "domain" -> `domain`).
 * The API additionally supports `fileSha256`; add it here + on the canvas when
 * needed. VERIFY the accepted set against a live Vision One tenant.
 */
export const OBJECT_TYPES = new Set(['domain', 'ip', 'url', 'fileSha1', 'senderMailAddress'])
/** Accepted scan actions: block = actively block, log = detect/monitor only. */
export const SCAN_ACTIONS = new Set(['block', 'log'])
/** Accepted risk levels. */
export const RISK_LEVELS = new Set(['high', 'medium', 'low'])

/**
 * One Trend Vision One suspicious object as sent to the add endpoint and (approx.)
 * as read back from the list endpoint. The identifier lives under a type-named key
 * (url/domain/ip/fileSha1/senderMailAddress). Field names are per the v3.0 API —
 * VERIFY against a live Vision One tenant.
 */
export interface SuspiciousObject {
  url?: string
  domain?: string
  ip?: string
  fileSha1?: string
  senderMailAddress?: string
  description?: string
  scanAction?: string
  riskLevel?: string
  /** Days until auto-expiry (integer). Omitted = tenant default / never. VERIFY units. */
  daysToExpiration?: number
  /** Present on list responses; the object's type. */
  type?: string
  [key: string]: unknown
}

/** Trim + lowercase an object value so two that differ only in case still match. */
export function normalizeValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The identifier field name the v3.0 API uses for a given object type. */
export function fieldForType(type: string): keyof SuspiciousObject | null {
  return OBJECT_TYPES.has(type) ? (type as keyof SuspiciousObject) : null
}

/** Read the identifier value out of a suspicious object (checks every known type key). */
export function valueOf(obj: SuspiciousObject): string {
  for (const type of OBJECT_TYPES) {
    const v = obj[type as keyof SuspiciousObject]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Vision One list responses carry the objects on `items` (with a `nextLink` for
 * pagination). Accept either that shape or a bare array. VERIFY against live
 * Vision One.
 */
export function objectsFromResponse(json: unknown): SuspiciousObject[] {
  if (Array.isArray(json)) return json as SuspiciousObject[]
  if (json && typeof json === 'object') {
    const items = (json as Record<string, unknown>).items
    if (Array.isArray(items)) return items as SuspiciousObject[]
  }
  return []
}

/** Find a live object by its (normalized) identifier value. */
export function findObject(objects: SuspiciousObject[], value: string): SuspiciousObject | null {
  const target = normalizeValue(value)
  if (!target) return null
  return objects.find((o) => normalizeValue(valueOf(o)) === target) ?? null
}

/**
 * Parse the optional daysToExpiration from a canvas field. Returns a positive
 * integer, or null when blank / non-positive / non-integer.
 */
export function parseDaysToExpiration(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Build the Vision One suspicious-object body from canvas fields. The identifier is
 * keyed by the object TYPE (e.g. { url: <value>, ... }); empty optionals are
 * omitted. Returns null when the type is unknown or the value is blank.
 */
export function buildObjectBody(fields: Record<string, unknown>): SuspiciousObject | null {
  const type = String(fields.type ?? '').trim()
  const key = fieldForType(type)
  const value = String(fields.value ?? '').trim()
  if (!key || !value) return null

  const obj: SuspiciousObject = { [key]: value }
  const description = String(fields.description ?? '').trim()
  if (description) obj.description = description
  const scanAction = String(fields.scanAction ?? '').trim()
  if (scanAction) obj.scanAction = scanAction
  const riskLevel = String(fields.riskLevel ?? '').trim()
  if (riskLevel) obj.riskLevel = riskLevel
  const days = parseDaysToExpiration(fields.daysToExpiration)
  if (days !== null) obj.daysToExpiration = days
  return obj
}

/** Build the minimal delete-request entry for an object: just its type-keyed value. */
export function buildDeleteBody(type: string, value: string): SuspiciousObject | null {
  const key = fieldForType(type)
  const v = value.trim()
  if (!key || !v) return null
  return { [key]: v }
}
