// =============================================================================
// Snyk audit log — drift attribution ("who changed it + when").
//
// When a config type detects that a live Snyk object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the Snyk Audit Logs REST API
// (GET /rest/orgs/{org_id}/audit_logs/search). The result is attached to each
// drifted diff as an optional `actor`, which the platform stores as-is and the
// client renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty log, no reachable audit
// scope, or no usable human event, it returns undefined and the diff is reported
// without an actor (the UI shows "—").
//
// Veltrix deploys authenticate with a Snyk service-account token, so their audit
// events carry that service account's user id. To attribute the MANUAL change
// (not our own deploy), the connection's identity is passed in
// `excludeActorLogins` (see veltrixActorLogins) and matching events are skipped.
//
// NOTE ON TYPES: snyk typechecks against an SDK build whose `DriftDiff` has no
// `actor` field, so this module declares its OWN `DriftActor` (it never imports
// one from the SDK) and sets the field STRUCTURALLY on an `object[]`, adding zero
// new tsc errors.
// =============================================================================

import { parseJson, type JsonApiEnvelope, type SnykClient } from './snyk'

/** Attribution attached to a drifted diff (a local shape — see the type note above). */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/**
 * A single Snyk audit event (data.items[] of the audit_logs/search response).
 * The formal schema defines `created`/`event`/`content`; the payload also carries
 * the acting user's id under one of a few historical keys, which are read
 * defensively.
 */
export interface SnykAuditEvent {
  created?: string
  event?: string
  content?: unknown
  org_id?: string
  group_id?: string
  project_id?: string
  /** Acting user id — the payload uses one of these keys across API generations. */
  userId?: string | null
  user_id?: string | null
  user_public_id?: string | null
  /** Rarely present actor display fields; used when the payload provides them. */
  user_email?: string | null
  user_name?: string | null
}

/** The `data` payload of an audit_logs/search response (JSON:API). */
interface AuditLogSearchData {
  items?: SnykAuditEvent[]
}

export interface ResolveDriftActorOptions {
  /** Object's Snyk id (integration/service-account/webhook id) — matched in the event content. */
  targetId?: string
  /** Object name/type/URL — a best-effort content match (e.g. a deleted object with no live id). */
  targetName?: string
  /**
   * Event-name prefixes for an org-SINGLETON config type (SAST, notifications)
   * that has no per-object id: an event is correlated to the singleton when its
   * `event` starts with one of these.
   */
  eventPrefixes?: string[]
  /** ISO lower bound for the audit window; defaults to ~7 days ago. */
  since?: string
  /** Page size for the audit query. */
  size?: number
  /** Connection identity/identities to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the audit query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** Page size for the audit query — the list is DESCENDING, so a small page suffices. */
const DEFAULT_SIZE = 50

/**
 * event-name substrings that represent a user-driven CHANGE (not a read). Snyk
 * audit event names read like `org.integration.edit` / `org.service_account.create`
 * / `org.webhook.add`; preferring a change verb keeps attribution on the mutation.
 */
const CHANGE_EVENT_HINTS = [
  '.edit',
  '.create',
  '.add',
  '.delete',
  '.remove',
  '.update',
  '.set',
  '.enable',
  '.disable',
  '.rotate',
  'settings',
]

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** The acting user id of an event (first non-empty of the historical keys). */
function actorId(event: SnykAuditEvent): string {
  return (
    normalize(event.userId) || normalize(event.user_id) || normalize(event.user_public_id)
  )
}

/** True when the event has a resolvable acting user (Snyk has no explicit human/service flag). */
function isHumanActor(event: SnykAuditEvent): boolean {
  return actorId(event) !== ''
}

/** True when the event's acting identity is one of the excluded (Veltrix) identities. */
function isExcludedActor(event: SnykAuditEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const candidates = [
    event.userId,
    event.user_id,
    event.user_public_id,
    event.user_email,
    event.user_name,
  ]
  return candidates.some((value) => {
    const n = normalize(value)
    return n !== '' && excluded.has(n)
  })
}

/** True when the event name looks like a change to a managed object. */
function isChangeEvent(event: SnykAuditEvent): boolean {
  const name = normalize(event.event)
  return CHANGE_EVENT_HINTS.some((hint) => name.includes(hint))
}

/** Map a chosen audit event to the DriftActor shape (only defined fields kept). */
function toActor(event: SnykAuditEvent): DriftActor {
  const actor: DriftActor = { source: 'snyk-audit' }
  const id = actorId(event)
  const email = normalize(event.user_email)
  const name = (typeof event.user_name === 'string' && event.user_name.trim()) || undefined
  if (id) actor.id = id
  // Prefer a real display name/email; fall back to the id so the UI shows something.
  if (name) actor.name = name
  else if (email) actor.name = email
  else if (id) actor.name = id
  if (email) actor.email = email
  if (event.created) actor.at = event.created
  if (event.event) actor.eventType = event.event
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live audit call. Considers only events with a resolvable
 * acting user that are non-excluded, and (defensively) sorts by `created`
 * DESCENDING so it is order-independent. Prefers a change-type event; if none
 * match, falls back to the most recent usable event. Returns undefined when
 * nothing usable remains.
 */
export function pickActorFromEvents(
  events: SnykAuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalize).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns DESCENDING, but sort defensively.
    .sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event))
  return toActor(preferred ?? candidates[0])
}

/** Lowercased haystack (event name + serialized content) used to correlate to a target. */
function correlationHaystack(event: SnykAuditEvent): string {
  let contentStr = ''
  try {
    contentStr = event.content ? JSON.stringify(event.content) : ''
  } catch {
    contentStr = ''
  }
  return `${event.event ?? ''} ${contentStr}`.toLowerCase()
}

/**
 * True when an event references the drifted object. For a per-object target the
 * id/name must appear in the event (name or serialized content); for an
 * org-singleton (no id/name) the event name must start with a configured prefix.
 */
function eventMatchesTarget(event: SnykAuditEvent, opts: ResolveDriftActorOptions): boolean {
  const id = normalize(opts.targetId)
  const name = normalize(opts.targetName)
  if (id || name) {
    const hay = correlationHaystack(event)
    if (id && hay.includes(id)) return true
    if (name && hay.includes(name)) return true
    return false
  }
  const prefixes = (opts.eventPrefixes ?? []).map(normalize).filter((p) => p !== '')
  if (prefixes.length === 0) return false
  const eventName = normalize(event.event)
  return prefixes.some((prefix) => eventName.startsWith(prefix))
}

/**
 * Resolve WHO last manually changed a drifted Snyk object and WHEN, from the org
 * audit log. Queries a DESCENDING time-window page and correlates each event to
 * the target CLIENT-SIDE (by id/name in the event, or by event-prefix for an
 * org-singleton) so an unrelated object's change is never attributed. Best-effort:
 * returns undefined on any error, an empty log, or no usable human event —
 * attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: SnykClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const hasTarget = Boolean(opts.targetId || opts.targetName)
    const hasPrefixes = Array.isArray(opts.eventPrefixes) && opts.eventPrefixes.length > 0
    if (!hasTarget && !hasPrefixes) return undefined

    const from = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const res = await client.rest('GET', `${client.restOrgPath()}/audit_logs/search`, {
      query: { from, size: opts.size ?? DEFAULT_SIZE, sort_order: 'DESC' },
    })
    if (!res.ok) return undefined

    const env = parseJson<JsonApiEnvelope<AuditLogSearchData>>(res.body)
    const items = env?.data?.items
    if (!Array.isArray(items)) return undefined

    const correlated = items.filter((event) => eventMatchesTarget(event, opts))
    return pickActorFromEvents(correlated, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so all five driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even though the SDK build's `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: SnykClient,
  diffs: object[],
  opts: ResolveDriftActorOptions,
): Promise<void> {
  if (!diffs || diffs.length === 0) return
  const actor = await resolveDriftActor(client, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The connection identity/identities to treat as Veltrix (excluded from
 * attribution). Snyk deploys authenticate with the connection's service-account
 * token, so the credential's `username` (and its display `name`) are the best
 * available handles for the identity our own changes appear under in the audit
 * log. Both are returned, de-duplicated, so whichever the payload echoes is matched.
 */
export function veltrixActorLogins(
  credential: { username?: string | null; name?: string | null } | null | undefined,
): string[] {
  const out: string[] = []
  for (const value of [credential?.username, credential?.name]) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}
