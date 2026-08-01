// Shared helpers for the Trend Vision One Suspicious Object Exception List (the
// safe / allow list) config type — deploy + rollback + drift.
//
// Endpoint paths + body shapes follow the Trend Vision One public API v3.0
// (Threat Intelligence -> Suspicious Object Exceptions). All three paths are
// CONFIRMED against the official Trend `pytmv1` SDK route table
// (trendmicro/tm-v1-pytv1, model/enum.py: ADD_TO_EXCEPTION_LIST /
// GET_EXCEPTION_OBJECTS / REMOVE_FROM_EXCEPTION_LIST). Field names are per the
// v3.0 API — VERIFY against a live Vision One tenant.

// --- Trend Vision One exception-list endpoints -------------------------------
// All hang off /v3.0 (added by the client). See lib/visionOneApi.ts.
export const EXCEPTION_ENDPOINTS = {
  /** List exception objects. GET; returns { items: [...], nextLink }. CONFIRMED. */
  list: '/threatintel/suspiciousObjectExceptions',
  /** Add exception objects. POST; body is an ARRAY of { <type>: value, description? }. CONFIRMED. */
  add: '/threatintel/suspiciousObjectExceptions',
  /** Remove exception objects. POST; body is an ARRAY of { <type>: value }. CONFIRMED. */
  delete: '/threatintel/suspiciousObjectExceptions/delete',
} as const

/**
 * Accepted exception object types. Each maps 1:1 to the identifier field name
 * the v3.0 API expects (e.g. type "domain" -> `domain`). The exception list
 * supports the full object-type set — including `fileSha256`, which the block
 * list historically did not. Confirmed against the pytmv1 `ObjectType` enum.
 * VERIFY against a live Vision One tenant.
 */
export const EXCEPTION_OBJECT_TYPES = new Set([
  'domain',
  'ip',
  'url',
  'fileSha1',
  'fileSha256',
  'senderMailAddress',
])

/**
 * One Trend Vision One exception object as sent to the add endpoint and (approx.)
 * read back from the list endpoint. The identifier lives under a type-named key.
 * Unlike a suspicious object, an exception carries no scan action / risk level /
 * expiration — only the value and an optional description. Field names are per the
 * v3.0 API — VERIFY against a live Vision One tenant.
 */
export interface ExceptionObject {
  url?: string
  domain?: string
  ip?: string
  fileSha1?: string
  fileSha256?: string
  senderMailAddress?: string
  description?: string
  /** Present on list responses; the object's type. */
  type?: string
  [key: string]: unknown
}

/** Trim + lowercase an object value so two that differ only in case still match. */
export function normalizeValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The identifier field name the v3.0 API uses for a given object type. */
export function fieldForType(type: string): keyof ExceptionObject | null {
  return EXCEPTION_OBJECT_TYPES.has(type) ? (type as keyof ExceptionObject) : null
}

/** Read the identifier value out of an exception object (checks every known type key). */
export function valueOf(obj: ExceptionObject): string {
  for (const type of EXCEPTION_OBJECT_TYPES) {
    const v = obj[type as keyof ExceptionObject]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * Vision One list responses carry the objects on `items` (with a `nextLink` for
 * pagination). Accept either that shape or a bare array. VERIFY against live
 * Vision One.
 */
export function objectsFromResponse(json: unknown): ExceptionObject[] {
  if (Array.isArray(json)) return json as ExceptionObject[]
  if (json && typeof json === 'object') {
    const items = (json as Record<string, unknown>).items
    if (Array.isArray(items)) return items as ExceptionObject[]
  }
  return []
}

/** Find a live exception by its (normalized) identifier value. */
export function findObject(objects: ExceptionObject[], value: string): ExceptionObject | null {
  const target = normalizeValue(value)
  if (!target) return null
  return objects.find((o) => normalizeValue(valueOf(o)) === target) ?? null
}

/**
 * Build the Vision One exception body from canvas fields: the identifier keyed by
 * the object TYPE, plus an optional description. Returns null when the type is
 * unknown or the value is blank.
 */
export function buildExceptionBody(fields: Record<string, unknown>): ExceptionObject | null {
  const type = String(fields.type ?? '').trim()
  const key = fieldForType(type)
  const value = String(fields.value ?? '').trim()
  if (!key || !value) return null

  const obj: ExceptionObject = { [key]: value }
  const description = String(fields.description ?? '').trim()
  if (description) obj.description = description
  return obj
}

/** Build the minimal delete-request entry for an exception: just its type-keyed value. */
export function buildExceptionDeleteBody(type: string, value: string): ExceptionObject | null {
  const key = fieldForType(type)
  const v = value.trim()
  if (!key || !v) return null
  return { [key]: v }
}
