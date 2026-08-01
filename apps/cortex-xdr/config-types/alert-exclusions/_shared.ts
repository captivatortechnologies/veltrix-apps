// Shared helpers for the Cortex XDR Alert Exclusions config type
// (deploy + rollback + drift).
//
// HONESTY: the Cortex XDR public API does NOT document ANY endpoint for alert
// exclusion / suppression rules — it is a console-only feature at the time of
// writing (confirmed against the Cortex XDR API references + PANW documentation).
// EVERY endpoint path below is therefore SPECULATIVE and FLAGGED. This config
// type ships the full authoring surface (canvas + validate) plus best-effort
// deploy/rollback/drift so it is ready the moment a public API is exposed, but on
// a current tenant the write calls will almost certainly 404. Do not treat any
// path here as confirmed.
//
// VERIFY every endpoint path, request/response shape and field name against a
// live Cortex XDR tenant before relying on this type.

// --- Cortex XDR alert-exclusion endpoints (ALL SPECULATIVE / FLAGGED) --------
// All POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const ALERT_EXCLUSION_ENDPOINTS = {
  /** SPECULATIVE — list exclusions. Body: { request_data: {} }. VERIFY (likely does not exist). */
  list: '/alerts/get_alert_exclusions/',
  /** SPECULATIVE — create/update an exclusion. Body: { request_data: { <exclusion> } }. VERIFY. */
  create: '/alerts/create_alert_exclusion/',
  /** SPECULATIVE — delete an exclusion by name. Body: { request_data: { name } }. VERIFY. */
  delete: '/alerts/delete_alert_exclusion/',
} as const

/**
 * One Cortex XDR alert exclusion. Field names are SPECULATIVE — VERIFY against
 * live Cortex XDR (no public schema is documented).
 */
export interface CortexAlertExclusion {
  name?: string
  /** The exclusion criteria — an opaque JSON object. VERIFY the field name + schema. */
  filter?: unknown
  comment?: string
  disabled?: boolean
  [key: string]: unknown
}

/** Trim + lowercase a name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Read a checkbox / boolean-ish field into a strict boolean. */
export function boolFromField(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1' || s === 'on'
}

/** Parse an optional JSON filter string. Returns null on blank; throws on invalid JSON. */
export function parseFilterJson(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  return JSON.parse(raw)
}

/** True when a filter string parses as JSON (blank counts as invalid — filter is required). */
export function isValidFilterJson(value: unknown): boolean {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Unwrap a (speculative) list response. Accept either a bare array on `reply`, or
 * `{ reply: { exclusions: [] } }` / `{ reply: { rules: [] } }`. VERIFY the real
 * shape against live Cortex XDR.
 */
export function exclusionsFromReply(reply: unknown): CortexAlertExclusion[] {
  if (Array.isArray(reply)) return reply as CortexAlertExclusion[]
  if (reply && typeof reply === 'object') {
    const obj = reply as Record<string, unknown>
    const inner = obj.exclusions ?? obj.rules ?? obj.data
    if (Array.isArray(inner)) return inner as CortexAlertExclusion[]
  }
  return []
}

/** Find a live exclusion by its (normalized) name. */
export function findExclusionByName(list: CortexAlertExclusion[], name: string): CortexAlertExclusion | null {
  const target = normalizeName(name)
  if (!target) return null
  return list.find((e) => normalizeName(e.name ?? (e as Record<string, unknown>).rule_name) === target) ?? null
}

/** Build the Cortex alert-exclusion body from canvas fields. */
export function buildExclusionBody(fields: Record<string, unknown>): CortexAlertExclusion {
  const exclusion: CortexAlertExclusion = {
    name: String(fields.name ?? '').trim(),
    disabled: boolFromField(fields.disabled),
  }
  const filter = parseFilterJson(fields.filter)
  if (filter !== null) exclusion.filter = filter
  const comment = String(fields.comment ?? '').trim()
  if (comment) exclusion.comment = comment
  return exclusion
}
