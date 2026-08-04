// Shared helpers for the Organization Webhooks config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares ONE organization webhook — a `name: "web"` HTTP
// callback with a config (url, content_type, secret, insecure_ssl), an event
// list and an active flag — via /orgs/{org}/hooks. Identified by (org, url),
// since GitHub webhooks do not carry a user-chosen name (`name` is always the
// literal string "web").
//
// `secret` is WRITE-ONLY: GitHub's GET/read response never echoes a
// configured secret back (typical secret-masking behavior, matching this
// repo's `jfrog-xray` Webhooks config type). Consequently: a blank Secret
// field on an existing webhook is NOT sent in the PATCH body (so it does not
// clear an existing secret), drift never compares it, and rollback cannot
// restore it — see README Coverage notes.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/orgs/webhooks

export const CONTENT_TYPES = ['json', 'form'] as const
export const INSECURE_SSL_VALUES = ['0', '1'] as const

/** GitHub's webhook config sub-object. `secret` is write-only — GitHub never returns it. */
export interface WebhookConfig {
  url?: string
  content_type?: string
  secret?: string
  insecure_ssl?: string
}

/** An org webhook as returned by GitHub. */
export interface LiveOrgWebhook {
  id?: number
  name?: string
  active?: boolean
  events?: string[]
  config?: WebhookConfig
}

/** The desired state one canvas item declares. */
export interface OrgWebhookDesired {
  org: string
  url: string
  contentType: string
  secret: string
  insecureSsl: string
  events: string[]
  active: boolean
}

/** Coerce a canvas value ('true' | true | 'enabled' | 1 | ...) to a boolean. */
export function normalizeBool(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  return s === 'true' || s === 'enabled' || s === '1' || s === 'yes' || s === 'on'
}

/** Read a tags/array field (real array, or a comma/newline separated string as a fallback). */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): OrgWebhookDesired {
  const events = toStringArray(fields.events)
  return {
    org: String(fields.org ?? '').trim(),
    url: String(fields.url ?? '').trim(),
    contentType: (String(fields.content_type ?? 'json').trim().toLowerCase() || 'json'),
    secret: String(fields.secret ?? '').trim(),
    insecureSsl: (String(fields.insecure_ssl ?? '0').trim() || '0'),
    events: events.length > 0 ? events : ['push'],
    active: normalizeBool(fields.active, true),
  }
}

/** Build the create/update body. `secret` is only included when the operator set a non-blank value. */
export function buildWebhookBody(desired: OrgWebhookDesired): Record<string, unknown> {
  const config: WebhookConfig = { url: desired.url, content_type: desired.contentType, insecure_ssl: desired.insecureSsl }
  if (desired.secret) config.secret = desired.secret
  return { name: 'web', config, events: desired.events, active: desired.active }
}

/** Find a live webhook by (org-scoped) URL. Case-insensitive, trimmed. */
export function findByUrl(webhooks: LiveOrgWebhook[], url: string): LiveOrgWebhook | undefined {
  const key = url.trim().toLowerCase()
  return webhooks.find((w) => (w.config?.url ?? '').trim().toLowerCase() === key)
}

/** What deploy records per webhook so rollback can restore (minus secret) or delete it. */
export interface OrgWebhookRollbackEntry {
  org: string
  url: string
  existed: boolean
  id?: number
  /** The prior webhook (existed=true only) — never carries a secret (GitHub omits it). */
  prior?: LiveOrgWebhook
}

/** Reconstruct the PATCH body that restores a prior webhook, MINUS its secret (never recoverable). */
export function restoreBody(prior: LiveOrgWebhook): Record<string, unknown> {
  return {
    config: {
      url: prior.config?.url ?? '',
      content_type: prior.config?.content_type ?? 'json',
      insecure_ssl: prior.config?.insecure_ssl ?? '0',
    },
    events: prior.events ?? ['push'],
    active: prior.active ?? true,
  }
}
