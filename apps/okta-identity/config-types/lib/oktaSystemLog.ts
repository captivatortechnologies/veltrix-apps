// =============================================================================
// Okta System Log — drift attribution ("who changed it + when").
//
// When a config type detects that a live Okta object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the Okta System Log API (GET /api/v1/logs). The result is attached
// to each DriftDiff as an optional `actor`, which the platform stores as-is and
// the client renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty log, or no usable human
// event, it returns undefined and the diff is reported without an actor.
//
// Veltrix's own deploys run through the connection's admin identity, so they
// appear in the log as that user. To attribute the MANUAL change (not our own
// deploy), the caller passes the connection's login(s) in `excludeActorLogins`
// and those events are skipped.
// =============================================================================

import { parseJson, type OktaClient } from '../../lib/okta'

/** Attribution attached to a drifted diff — mirrors the SDK's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** A System Log actor/target principal (the fields we read). */
interface LogPrincipal {
  id?: string
  displayName?: string
  alternateId?: string
  type?: string
}

/** A single System Log event (only the fields we read). */
export interface SystemLogEvent {
  actor?: LogPrincipal
  published?: string
  eventType?: string
  target?: LogPrincipal[]
}

export interface ResolveDriftActorOptions {
  /** Okta object id — the most reliable target for the log filter. */
  targetId?: string
  /** Object name/login — a best-effort fallback when the id is unknown (deletes). */
  targetName?: string
  /** ISO lower bound for the log window; defaults to ~7 days ago. */
  since?: string
  /** Connection login(s) to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the log query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** The list is DESCENDING, so a small page is enough to find the last human change. */
const LOG_LIMIT = 20

/**
 * eventType prefixes that represent a user-driven CHANGE to a managed object.
 * A `pickActor` first pass prefers these; if none match it falls back to the
 * most recent human, non-Veltrix event so attribution is still best-effort.
 */
const CHANGE_EVENT_PREFIXES = [
  'group.lifecycle.',
  'group.user_membership.',
  'group.rule.',
  'group.privilege.',
  'user.lifecycle.',
  'user.account.',
  'policy.',
  'zone.',
  'application.',
]

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** True when the event's actor is a human user (not a service/system principal). */
function isHumanActor(event: SystemLogEvent): boolean {
  return event.actor?.type === 'User'
}

/** True when the event's actor is one of the excluded (Veltrix) logins. */
function isExcludedActor(event: SystemLogEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const alt = normalizeLogin(event.actor?.alternateId)
  const name = normalizeLogin(event.actor?.displayName)
  return (alt !== '' && excluded.has(alt)) || (name !== '' && excluded.has(name))
}

/** True when the eventType looks like a change to a managed object. */
function isChangeEvent(eventType: string | undefined): boolean {
  const t = eventType ?? ''
  return CHANGE_EVENT_PREFIXES.some((prefix) => t.startsWith(prefix))
}

/** Map a chosen log event to the DriftActor shape (only defined fields kept). */
function toActor(event: SystemLogEvent): DriftActor {
  const actor: DriftActor = { source: 'okta-system-log' }
  if (event.actor?.id) actor.id = event.actor.id
  if (event.actor?.displayName) actor.name = event.actor.displayName
  if (event.actor?.alternateId) actor.email = event.actor.alternateId
  if (event.published) actor.at = event.published
  if (event.eventType) actor.eventType = event.eventType
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live System Log call. Considers only human (`actor.type ===
 * 'User'`), non-excluded events, and (defensively) sorts by `published`
 * DESCENDING so it is order-independent. Prefers a change-type eventType; if
 * none match, falls back to the most recent human, non-excluded event. Returns
 * undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  events: SystemLogEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns DESCENDING, but sort defensively.
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event.eventType))
  return toActor(preferred ?? candidates[0])
}

/**
 * Resolve WHO last manually changed a drifted Okta object and WHEN, from the
 * System Log. Uses `target.id eq "<id>"` when the object id is known (the
 * reliable path — every drifted-but-present object has one), else a free-text
 * `q=<name>` query as a best-effort fallback (e.g. a deleted object with no live
 * id). Best-effort: returns undefined on any error, an empty log, or no usable
 * human event — attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: OktaClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const query: Record<string, string | number> = {
      since,
      sortOrder: 'DESCENDING',
      limit: LOG_LIMIT,
    }

    if (opts.targetId) {
      // OktaClient encodes each query value via URLSearchParams, so the whole
      // SCIM filter expression is URL-encoded correctly.
      query.filter = `target.id eq "${opts.targetId}"`
    } else if (opts.targetName) {
      query.q = opts.targetName
    } else {
      return undefined
    }

    const res = await client.request('GET', '/logs', { query })
    if (!res.ok) return undefined

    const events = parseJson<SystemLogEvent[]>(res.body)
    if (!Array.isArray(events)) return undefined

    return pickActorFromEvents(events, opts.excludeActorLogins ?? [])
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
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: OktaClient,
  diffs: object[],
  opts: ResolveDriftActorOptions,
): Promise<void> {
  if (!diffs || diffs.length === 0) return
  const actor = await resolveDriftActor(client, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The connection login(s) to treat as Veltrix (excluded from attribution). The
 * connection's credential authenticates our deploys, so its username is the
 * identity our own changes appear under in the System Log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
