// Shared helpers for the Cortex XDR Legacy Exceptions config type (deploy +
// rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, Endpoint Management tag: /public_api/v1/legacy_exceptions/{get_modules,
// fetch, add, edit, delete}) — full CRUD for prevention-module exceptions
// (allow a specific hash/path/signer/command to bypass a named protection
// module on matching endpoints).
//
// This is the BASE-LICENSE-eligible equivalent of the newer "Disable Prevention
// Rule" API (`/public_api/v1/disable_prevention/*`), which this app does NOT
// implement — that surface requires the Cortex Cloud Posture Management add-on
// license (see the README Coverage section). "Legacy" here is Palo Alto's own
// name for the endpoint family, not a signal that it is deprecated or unsafe to
// use — it remains the confirmed, unrestricted public write path for this kind
// of exception on a plain Cortex XDR tenant.
//
// An exception has no caller-chosen identity — Cortex assigns a string
// `exception_id` (returned as `id` on fetch) on add — so this type reconciles
// by NAME (`rule_name`): fetch -> match -> edit by exception_id, or add.
//
// VERIFY every endpoint path, request/response field name, the exact module_id
// values (via get_modules, not modeled here) and the accepted platform values
// against a live Cortex XDR tenant.

// --- Cortex XDR legacy-exception endpoints (VERIFY against live Cortex XDR) --
// All are POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const LEGACY_EXCEPTION_ENDPOINTS = {
  /** List/search exceptions. Body: { request_data: { search_from?, search_to?, sort?, filters? } }. */
  fetch: '/legacy_exceptions/fetch/',
  /** Add a new exception. Body: { request_data: { name, platform, module, profile_ids, status, scope, description?, conditions } }. */
  add: '/legacy_exceptions/add/',
  /** Edit an exception. Body: { request_data: { exception_id, update_data: { ...same fields as add } } }. */
  edit: '/legacy_exceptions/edit/',
  /** Delete exceptions by id. Body: { request_data: { exception_ids: [...] } }. */
  delete: '/legacy_exceptions/delete/',
} as const

/** Documented elsewhere in this API family (disable_injection_prevention_rules); VERIFY for this endpoint specifically. */
export const LEGACY_EXCEPTION_PLATFORMS = new Set(['windows', 'linux', 'macos'])
export const LEGACY_EXCEPTION_STATUSES = new Set(['enabled', 'disabled'])
export const LEGACY_EXCEPTION_SCOPES = new Set(['global', 'profile'])

/** One legacy exception as sent to add/edit. */
export interface LegacyExceptionBody {
  name: string
  platform: string
  module: number
  profile_ids?: number[]
  status: string
  scope: string
  description?: string
  conditions: unknown
}

/** One legacy exception as read back from fetch. */
export interface LiveLegacyException {
  id?: string
  rule_name?: string
  platform?: string
  conditions?: unknown
  module?: number
  module_name?: string
  description?: string
  status?: string
  scope?: string
  profile_ids?: number[]
  [key: string]: unknown
}

/** Trim + lowercase a name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** /legacy_exceptions/fetch wraps its payload as { reply: { DATA: [...] } }. VERIFY. */
export function exceptionsFromReply(reply: unknown): LiveLegacyException[] {
  if (Array.isArray(reply)) return reply as LiveLegacyException[]
  if (reply && typeof reply === 'object') {
    const obj = reply as Record<string, unknown>
    const inner = obj.DATA ?? obj.data
    if (Array.isArray(inner)) return inner as LiveLegacyException[]
  }
  return []
}

/** Find a live exception by its (normalized) rule name. */
export function findException(exceptions: LiveLegacyException[], name: string): LiveLegacyException | null {
  const target = normalizeName(name)
  if (!target) return null
  return exceptions.find((e) => normalizeName(e.rule_name) === target) ?? null
}

/** Parse the required conditions JSON blob. Throws on invalid JSON or a blank value. */
export function parseConditionsJson(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('conditions is required')
  return JSON.parse(raw)
}

/** True when the conditions JSON blob parses as valid, non-blank JSON. */
export function isValidConditionsJson(value: unknown): boolean {
  try {
    parseConditionsJson(value)
    return true
  } catch {
    return false
  }
}

/** Build the add/edit body from canvas fields. Throws when conditions is missing/invalid JSON. */
export function buildLegacyExceptionBody(fields: Record<string, unknown>): LegacyExceptionBody {
  const body: LegacyExceptionBody = {
    name: String(fields.name ?? '').trim(),
    platform: String(fields.platform ?? '').trim().toLowerCase(),
    module: Number(fields.module ?? 0) || 0,
    status: String(fields.status ?? '').trim().toLowerCase() || 'enabled',
    scope: String(fields.scope ?? '').trim().toLowerCase() || 'global',
    conditions: parseConditionsJson(fields.conditions),
  }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  const profileIds = Array.isArray(fields.profile_ids)
    ? (fields.profile_ids as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
    : []
  if (profileIds.length) body.profile_ids = profileIds
  return body
}
