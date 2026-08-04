// Shared helpers for the Cortex XDR Syslog Integrations config type (deploy +
// rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, Syslog Servers tag) — a genuine full CRUD surface, unlike most of this
// app's other config types: /public_api/v1/integrations/syslog/create, /get,
// /update, /delete (plus /test, intentionally NOT wired into deploy/healthCheck
// — see the README — since it fires a real test message at the destination).
//
// A syslog integration has NO caller-chosen identity: create is assigned a
// numeric `syslog_integration_id` server-side. This type reconciles by NAME —
// list (optionally filtered by name) -> match -> update by id, or create.
//
// VERIFY every endpoint path, request/response field name and enum value against
// a live Cortex XDR tenant.

// --- Cortex XDR syslog-integration endpoints (VERIFY against live Cortex XDR) -
// All are POST under /public_api/v1. The client prepends the base + /public_api/v1.
export const SYSLOG_ENDPOINTS = {
  create: '/integrations/syslog/create/',
  /** List/search syslog integrations. Body: { request_data: { filters?: [...] } }. */
  get: '/integrations/syslog/get/',
  update: '/integrations/syslog/update/',
  /** Delete matching integrations. Body: { request_data: { filters: [...] } }. */
  delete: '/integrations/syslog/delete/',
} as const

export const SYSLOG_PROTOCOLS = new Set(['TCP', 'UDP', 'TLS'])

/** A syslog integration as authored on the canvas / sent to create+update. */
export interface SyslogIntegrationBody {
  name: string
  address: string
  port: number
  protocol: string
  facility?: string
  security_info?: {
    certificate_name?: string
    ignore_cert_errors?: boolean
    certificate_content?: string
  }
}

/**
 * A syslog integration as read back from /integrations/syslog/get — Cortex
 * returns SCREAMING_SNAKE_CASE keys on read that differ from the lowerCamel
 * create/update request field names. VERIFY this mapping against a live tenant.
 */
export interface LiveSyslogIntegration {
  SYSLOG_INTEGRATION_ID?: number
  SYSLOG_INTEGRATION_NAME?: string
  SYSLOG_INTEGRATION_ADDRESS?: string
  SYSLOG_INTEGRATION_PORT?: number
  SYSLOG_INTEGRATION_PROTOCOL?: string
  FACILITY?: string
  SYSLOG_INTEGRATION_STATUS?: string
  [key: string]: unknown
}

/** Trim + lowercase a name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** /integrations/syslog/get wraps its payload as { reply: { objects: [...] } }. VERIFY. */
export function syslogIntegrationsFromReply(reply: unknown): LiveSyslogIntegration[] {
  if (Array.isArray(reply)) return reply as LiveSyslogIntegration[]
  if (reply && typeof reply === 'object') {
    const inner = (reply as Record<string, unknown>).objects
    if (Array.isArray(inner)) return inner as LiveSyslogIntegration[]
  }
  return []
}

/** Find a live syslog integration by its (normalized) name. */
export function findSyslogIntegration(live: LiveSyslogIntegration[], name: string): LiveSyslogIntegration | null {
  const target = normalizeName(name)
  if (!target) return null
  return live.find((s) => normalizeName(s.SYSLOG_INTEGRATION_NAME) === target) ?? null
}

/** Build the create/update body from canvas fields. Omits empty optionals. */
export function buildSyslogIntegrationBody(fields: Record<string, unknown>): SyslogIntegrationBody {
  const body: SyslogIntegrationBody = {
    name: String(fields.name ?? '').trim(),
    address: String(fields.address ?? '').trim(),
    port: Number(fields.port ?? 0) || 0,
    protocol: String(fields.protocol ?? '').trim().toUpperCase() || 'TCP',
  }
  const facility = String(fields.facility ?? '').trim()
  if (facility) body.facility = facility

  const certificateName = String(fields.certificate_name ?? '').trim()
  const certificateContent = String(fields.certificate_content ?? '').trim()
  const ignoreCertErrors = fields.ignore_cert_errors === true || fields.ignore_cert_errors === 'true'
  if (certificateName || certificateContent || ignoreCertErrors) {
    body.security_info = {}
    if (certificateName) body.security_info.certificate_name = certificateName
    if (certificateContent) body.security_info.certificate_content = certificateContent
    if (ignoreCertErrors) body.security_info.ignore_cert_errors = true
  }

  return body
}
