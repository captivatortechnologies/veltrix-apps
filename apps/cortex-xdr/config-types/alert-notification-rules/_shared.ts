// Shared helpers for the Cortex XDR Alert Notification Rules config type
// (deploy + rollback + drift).
//
// CONFIRMED public write path (re-verified 2026-08 against the "Cortex Platform"
// docs, Alert Notification Rules tag — Cortex XDR 5.1) — a genuine full CRUD
// surface for routing alerts to email / Slack / Syslog / external applications
// (webhook, Splunk, AWS SQS, AWS S3). This is DIFFERENT from this app's existing
// `alert-exclusions` config type: exclusions SUPPRESS alerts and have NO
// documented public API (still speculative — see that type's README section);
// notification rules ROUTE alerts that already fired and are fully documented.
//
// Like External Applications, these endpoints live under
// `/platform/notifications/v1/...` and speak plain REST verbs with a bare JSON
// body — no `{ request_data }` / `{ reply }` RPC envelope. See
// lib/cortexXdrApi.ts `request()` for the client seam and its auth caveat.
//
// A rule is identified by a server-assigned `rule_uuid` — this type reconciles
// by NAME: list -> match -> update by uuid, or create.
//
// `forward_source.syslog.id` references a Syslog Integration's numeric id (this
// app's `syslog-integrations` config type); `applications` references External
// Application ids (this app's `external-applications` config type) — both are
// authored here as plain identifiers, not cross-type-resolved.
//
// VERIFY every endpoint path, request/response field name and the complete
// LogForwardType enum (not printed inline in the source docs) against a live
// Cortex XDR tenant.

// --- Cortex XDR alert-notification-rule endpoints (VERIFY against live Cortex XDR) --
// All are full paths (NOT relative to /public_api/v1) — pass to client.request().
export const NOTIFICATION_RULE_BASE = '/platform/notifications/v1'
export const NOTIFICATION_RULE_ENDPOINTS = {
  list: `${NOTIFICATION_RULE_BASE}/list-rules`,
  create: `${NOTIFICATION_RULE_BASE}/rule`,
  ruleById: (uuid: string) => `${NOTIFICATION_RULE_BASE}/rule/${uuid}`,
  statusById: (uuid: string) => `${NOTIFICATION_RULE_BASE}/update-rule-status/${uuid}`,
} as const

/** Documented per the Rule schema; the `issue`/`legacy_alert` formats apply only to the "alert" forward_type. */
export const NOTIFICATION_FORMATS = new Set(['issue', 'standard_alert', 'legacy_alert'])
export const SLACK_FORMATS = new Set(['issue', 'standard_alert']) // legacy_alert is not permitted for Slack

export interface ForwardSource {
  email?: { distribution_list: string[]; aggregation?: number; custom_mail_subject?: string }
  slack?: { channels: string[] }
  syslog?: { id: number }
}

/** An alert notification rule as authored on the canvas / sent to create+update. */
export interface NotificationRuleBody {
  name: string
  description?: string
  forward_type: string
  filter?: unknown
  forward_source?: ForwardSource
  applications?: string[]
  time_zone?: string
  mail_format?: string
  syslog_format?: string
  slack_format?: string
}

/** An alert notification rule as read back from the list/get endpoints. */
export interface LiveNotificationRule {
  rule_uuid?: string
  name?: string
  description?: string
  forward_type?: string
  filter?: unknown
  forward_source?: ForwardSource
  applications?: string[]
  time_zone?: string
  mail_format?: string
  syslog_format?: string
  slack_format?: string
  enabled?: boolean
  [key: string]: unknown
}

/** Trim + lowercase a name so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** The list endpoint wraps its payload as { data: [...] }. VERIFY. */
export function rulesFromResponse(payload: unknown): LiveNotificationRule[] {
  if (Array.isArray(payload)) return payload as LiveNotificationRule[]
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>).data
    if (Array.isArray(inner)) return inner as LiveNotificationRule[]
  }
  return []
}

/** The create/get-by-id endpoints wrap their payload as { data: {...} }. VERIFY. */
export function ruleFromResponse(payload: unknown): LiveNotificationRule | null {
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>).data
    if (inner && typeof inner === 'object') return inner as LiveNotificationRule
  }
  return null
}

/** Find a live rule by its (normalized) name. */
export function findRule(rules: LiveNotificationRule[], name: string): LiveNotificationRule | null {
  const target = normalizeName(name)
  if (!target) return null
  return rules.find((r) => normalizeName(r.name) === target) ?? null
}

/** Parse the required filter JSON blob. Throws on invalid JSON or a blank value. */
export function parseFilterJson(value: unknown): unknown {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('filter is required')
  return JSON.parse(raw)
}

/** True when the filter JSON blob parses as valid, non-blank JSON. */
export function isValidFilterJson(value: unknown): boolean {
  try {
    parseFilterJson(value)
    return true
  } catch {
    return false
  }
}

/** Build forward_source from canvas fields. Returns undefined when no channel is configured. */
export function buildForwardSource(fields: Record<string, unknown>): ForwardSource | undefined {
  const source: ForwardSource = {}

  const emailList = Array.isArray(fields.email_distribution_list)
    ? (fields.email_distribution_list as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : []
  if (emailList.length) {
    source.email = { distribution_list: emailList }
    const aggregation = Number(fields.email_aggregation ?? NaN)
    if (Number.isFinite(aggregation)) source.email.aggregation = aggregation
    const subject = String(fields.email_custom_mail_subject ?? '').trim()
    if (subject) source.email.custom_mail_subject = subject
  }

  const slackChannels = Array.isArray(fields.slack_channels)
    ? (fields.slack_channels as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : []
  if (slackChannels.length) source.slack = { channels: slackChannels }

  const syslogId = Number(fields.syslog_integration_id ?? NaN)
  if (Number.isFinite(syslogId) && syslogId > 0) source.syslog = { id: syslogId }

  return Object.keys(source).length > 0 ? source : undefined
}

/** Build the create/update body from canvas fields. Throws when filter is missing/invalid JSON. */
export function buildNotificationRuleBody(fields: Record<string, unknown>): NotificationRuleBody {
  const body: NotificationRuleBody = {
    name: String(fields.name ?? '').trim(),
    forward_type: String(fields.forward_type ?? '').trim(),
    filter: parseFilterJson(fields.filter),
  }

  const description = String(fields.description ?? '').trim()
  if (description) body.description = description

  const forwardSource = buildForwardSource(fields)
  if (forwardSource) body.forward_source = forwardSource

  const applications = Array.isArray(fields.applications)
    ? (fields.applications as unknown[]).map((v) => String(v).trim()).filter(Boolean)
    : []
  if (applications.length) body.applications = applications

  const timeZone = String(fields.time_zone ?? '').trim()
  if (timeZone) body.time_zone = timeZone

  const mailFormat = String(fields.mail_format ?? '').trim()
  if (mailFormat) body.mail_format = mailFormat
  const syslogFormat = String(fields.syslog_format ?? '').trim()
  if (syslogFormat) body.syslog_format = syslogFormat
  const slackFormat = String(fields.slack_format ?? '').trim()
  if (slackFormat) body.slack_format = slackFormat

  return body
}
