// Shared helpers for the Cortex XDR External Applications config type (deploy +
// rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, External Application Management tag) — a genuine full CRUD surface for
// the webhook / Splunk / AWS SQS / AWS S3 / Syslog integration targets that
// Alert Notification Rules route to. Unlike every other config type in this app,
// these endpoints live under `/platform/integration/v1/...` and speak plain REST
// verbs (GET/POST/PUT/DELETE) with a bare JSON body — no `{ request_data }` /
// `{ reply }` RPC envelope. See lib/cortexXdrApi.ts `request()` for the client
// seam and its auth caveat.
//
// An application has no caller-chosen identity — Cortex assigns a numeric
// `application_id` on create — so this type reconciles by NAME: list -> match ->
// update by (type, id), or create.
//
// VERIFY every endpoint path, request/response field name and the exact
// per-type `connection_config` shape against a live Cortex XDR tenant — Cortex's
// own docs describe it only as "documented in the respective schemas" without
// printing them inline.

// --- Cortex XDR external-application endpoints (VERIFY against live Cortex XDR) --
// All are full paths (NOT relative to /public_api/v1) — pass to client.request().
export const EXTERNAL_APPLICATION_BASE = '/platform/integration/v1/external-application'

export const APPLICATION_TYPES = new Set(['syslog', 'webhook', 'splunk', 'aws_sqs', 'aws_s3'])

/** An external application as authored on the canvas / sent to create+update. */
export interface ExternalApplicationBody {
  name: string
  description?: string
  application_type: string
  connection_config: Record<string, unknown>
}

/** An external application as read back from the list/get endpoints. */
export interface LiveExternalApplication {
  application_id?: number
  name?: string
  description?: string
  application_type?: string
  status?: string
  connection_config?: Record<string, unknown>
  [key: string]: unknown
}

/** Trim + lowercase a name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The list endpoint wraps its payload as { data: [...] }. VERIFY. */
export function applicationsFromResponse(payload: unknown): LiveExternalApplication[] {
  if (Array.isArray(payload)) return payload as LiveExternalApplication[]
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>).data
    if (Array.isArray(inner)) return inner as LiveExternalApplication[]
  }
  return []
}

/** The create/update/get-by-id endpoints wrap their payload as { data: {...} }. VERIFY. */
export function applicationFromResponse(payload: unknown): LiveExternalApplication | null {
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>).data
    if (inner && typeof inner === 'object') return inner as LiveExternalApplication
  }
  return null
}

/** Find a live application by its (normalized) name. */
export function findApplication(apps: LiveExternalApplication[], name: string): LiveExternalApplication | null {
  const target = normalizeName(name)
  if (!target) return null
  return apps.find((a) => normalizeName(a.name) === target) ?? null
}

/** Build the create/update body from canvas fields. `connection_config` is passed through as declared JSON. */
export function buildApplicationBody(fields: Record<string, unknown>): ExternalApplicationBody {
  const body: ExternalApplicationBody = {
    name: String(fields.name ?? '').trim(),
    application_type: String(fields.application_type ?? '').trim().toLowerCase(),
    connection_config: parseConnectionConfig(fields.connection_config),
  }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description
  return body
}

/** Parse the connection_config JSON blob. Returns {} on blank; throws on invalid JSON. */
export function parseConnectionConfig(value: unknown): Record<string, unknown> {
  const raw = String(value ?? '').trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('connection_config must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** True when connection_config is blank or parses as a JSON object. */
export function isValidConnectionConfig(value: unknown): boolean {
  try {
    parseConnectionConfig(value)
    return true
  } catch {
    return false
  }
}
