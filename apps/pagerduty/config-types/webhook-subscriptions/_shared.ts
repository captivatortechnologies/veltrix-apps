// Shared helpers for the PagerDuty Webhook Subscriptions config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty (v3) webhook subscription lives at /webhook_subscriptions and
// delivers HTTP callbacks for incident events. PagerDuty's own model gives it
// NO required or unique name — only an optional `description`. This app makes
// `description` REQUIRED and uses it as the reconciliation identity (the same
// role `name` plays for every other config type in this app); this is an
// APP-LEVEL convention, not a PagerDuty constraint, so operators must keep
// descriptions unique across their declared subscriptions.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's official OpenAPI v2 spec):
//   list:   GET    /webhook_subscriptions          -> { webhook_subscriptions: [...] }
//   create: POST   /webhook_subscriptions          <- { webhook_subscription: {...} }
//   get:    GET    /webhook_subscriptions/{id}      -> { webhook_subscription: {...} }
//   update: PUT    /webhook_subscriptions/{id}      <- { webhook_subscription: {...} }
//   delete: DELETE /webhook_subscriptions/{id}
//
// Docs: https://developer.pagerduty.com/api-reference/9d0106f5f568b-create-a-webhook-subscription
//
// NOTE on custom_headers: PagerDuty redacts header VALUES on every GET (per its
// own OpenAPI description — "redacted in GET requests, but are not redacted on
// the webhook when delivered"). deploy.ts reads the live subscription to build
// the rollback `prior` snapshot, so a captured prior's custom_headers values
// are already PagerDuty's redacted placeholders, not the real secret. Rollback
// restores that snapshot verbatim (the same imperfect-but-honest approach the
// jfrog-xray webhooks config type takes for its write-only password field) —
// after a rollback that restores an UPDATED subscription, any custom header
// value may need to be re-entered manually.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** The exact set of incident event types PagerDuty v3 webhook subscriptions accept. */
export const VALID_EVENT_TYPES = new Set([
  'incident.acknowledged',
  'incident.annotated',
  'incident.delegated',
  'incident.escalated',
  'incident.priority_updated',
  'incident.reassigned',
  'incident.reopened',
  'incident.resolved',
  'incident.responder.added',
  'incident.responder.replied',
  'incident.status_update_published',
  'incident.triggered',
  'incident.unacknowledged',
])

/** The three filter scopes a webhook subscription can be scoped to. */
export const VALID_FILTER_TYPES = new Set(['account_reference', 'service_reference', 'team_reference'])

/** One custom HTTP header sent with every webhook delivery. */
export interface CustomHeader {
  name: string
  value: string
}

/** The HTTP delivery target for a webhook subscription. */
export interface DeliveryMethod {
  id?: string
  type?: string
  url?: string
  temporarily_disabled?: boolean
  custom_headers?: CustomHeader[]
  /** Only ever present on the initial create response; never sent by this app. */
  secret?: string | null
}

/** The filter scoping which events reach this subscription. */
export interface WebhookFilter {
  id?: string
  type?: string
}

/** A webhook subscription as returned by GET /webhook_subscriptions. */
export interface LiveWebhookSubscription {
  id?: string
  type?: string
  active?: boolean
  delivery_method?: DeliveryMethod
  description?: string
  events?: string[]
  filter?: WebhookFilter
}

/** One canvas item, normalized to the fields this config type manages. */
export interface WebhookSubscriptionSpec {
  itemName: string
  /** REQUIRED by this app — see the file header on why this, and not PagerDuty's own model, is the identity. */
  description: string
  url: string
  active: boolean
  /** Raw JSON text for the events array. */
  eventsJson: string
  filterType: string
  /** The NAME of the service/team to filter on; resolved to an id at deploy when filterType requires one. */
  filterTarget: string
  /** Raw JSON text for the optional custom_headers array. */
  customHeadersJson: string
}

/**
 * Result of parsing the events JSON. NOT a discriminated union — the platform's
 * handler loader does not narrow `{ ok:true } | { ok:false }`, so `events` and
 * `error` are always-present nullable fields (same convention as
 * escalation-policies' RulesParseResult).
 */
export interface EventsParseResult {
  events: string[] | null
  error: string | null
}

/** Same nullable-pair convention as EventsParseResult, for the optional `custom_headers` array. */
export interface CustomHeadersParseResult {
  headers: CustomHeader[] | null
  error: string | null
}

/** Each canvas item describes one webhook subscription. */
export function extractWebhookSubscriptionSpecs(canvas: CanvasSnapshot): WebhookSubscriptionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      url: typeof fields.url === 'string' ? fields.url.trim() : '',
      active: typeof fields.active === 'boolean' ? fields.active : true,
      eventsJson: typeof fields.events === 'string' ? fields.events : '',
      filterType: typeof fields.filter_type === 'string' ? fields.filter_type.trim() : '',
      filterTarget: typeof fields.filter_target === 'string' ? fields.filter_target.trim() : '',
      customHeadersJson: typeof fields.custom_headers === 'string' ? fields.custom_headers : '',
    }
  })
}

/**
 * Parse + validate the events JSON: a non-empty array where every entry is one
 * of PagerDuty's known incident event-type strings (VALID_EVENT_TYPES).
 */
export function parseEvents(raw: string | undefined): EventsParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { events: null, error: 'is required (a non-empty JSON array of event types)' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { events: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { events: null, error: 'must be a JSON array of event types' }
  if (parsed.length === 0) return { events: null, error: 'must contain at least one event type' }

  const events: string[] = []
  for (let i = 0; i < parsed.length; i++) {
    const value = parsed[i]
    if (typeof value !== 'string' || !VALID_EVENT_TYPES.has(value)) {
      return {
        events: null,
        error: `entry ${i + 1} ("${String(value)}") must be one of ${[...VALID_EVENT_TYPES].join(', ')}`,
      }
    }
    events.push(value)
  }
  return { events, error: null }
}

/**
 * Parse + shallow-validate the optional custom_headers JSON: an array of
 * { name, value } pairs, both non-empty strings. Shape-only — PagerDuty is the
 * real judge of any per-destination header semantics.
 */
export function parseCustomHeaders(raw: string | undefined): CustomHeadersParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { headers: null, error: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { headers: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { headers: null, error: 'must be a JSON array of { name, value } pairs' }

  const headers: CustomHeader[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown>
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    const value = typeof entry?.value === 'string' ? entry.value : ''
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !name) {
      return { headers: null, error: `entry ${i + 1} must be an object with a non-empty "name" and a "value"` }
    }
    headers.push({ name, value })
  }
  return { headers, error: null }
}

/**
 * Build the request body for POST/PUT /webhook_subscriptions. Wrapped in a
 * { webhook_subscription: {...} } envelope by callers. `filterTargetId` is
 * omitted from the filter when the filter type is account_reference (which
 * takes no id).
 *
 * SECURITY NOTE: `custom_headers` values may carry an auth secret for the
 * destination endpoint — PagerDuty's own docs recommend a custom header over
 * embedding a token in the URL, but either way this app stores and displays
 * the value like any other declared field (visible in the Configuration
 * Canvas, drift diffs, and audit history).
 */
export function buildWebhookSubscriptionBody(
  spec: WebhookSubscriptionSpec,
  events: string[],
  filterTargetId: string | null,
  headers: CustomHeader[] | null,
): LiveWebhookSubscription {
  const deliveryMethod: DeliveryMethod = { type: 'http_delivery_method', url: spec.url }
  if (headers && headers.length > 0) deliveryMethod.custom_headers = headers

  const filter: WebhookFilter = { type: spec.filterType }
  if (filterTargetId) filter.id = filterTargetId

  return {
    type: 'webhook_subscription',
    active: spec.active,
    delivery_method: deliveryMethod,
    description: spec.description,
    events,
    filter,
  }
}

/** Rebuild a webhook subscription body from its prior live shape (used by rollback restore). */
export function webhookSubscriptionRestoreBody(prior: LiveWebhookSubscription): LiveWebhookSubscription {
  const deliveryMethod: DeliveryMethod = { type: 'http_delivery_method', url: prior.delivery_method?.url ?? '' }
  if (Array.isArray(prior.delivery_method?.custom_headers) && prior.delivery_method.custom_headers.length > 0) {
    deliveryMethod.custom_headers = prior.delivery_method.custom_headers.map((h) => ({ name: h.name, value: h.value }))
  }

  const filter: WebhookFilter = { type: prior.filter?.type ?? 'account_reference' }
  if (prior.filter?.id) filter.id = prior.filter.id

  return {
    type: 'webhook_subscription',
    active: typeof prior.active === 'boolean' ? prior.active : true,
    delivery_method: deliveryMethod,
    description: String(prior.description ?? ''),
    events: Array.isArray(prior.events) ? prior.events : [],
    filter,
  }
}

/** Find a live subscription by description (case-insensitive — the app-level reconciliation identity). */
export function findWebhookSubscription(
  subscriptions: LiveWebhookSubscription[],
  description: string,
): LiveWebhookSubscription | null {
  const d = description.trim().toLowerCase()
  if (!d) return null
  return subscriptions.find((s) => String(s.description ?? '').trim().toLowerCase() === d) ?? null
}

/** Resolve a service or team NAME to its id (case-insensitive) — used for a service_reference/team_reference filter. */
export function findFilterTargetId(targets: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = targets.find((t) => String(t.name ?? '').trim().toLowerCase() === n)
  return match?.id ?? null
}
