// =============================================================================
// Qualys User Activity Log — drift attribution ("who changed it + when").
//
// When a config type detects that a live Qualys object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the classic v2 User Activity Log API:
//   POST /api/2.0/fo/activity_log/?action=list&output_format=XML
//        &since_datetime=<iso-7d>&truncation_limit=50
// Each <USER_ACTIVITY_LOG> block carries <DATE>, <ACTION>, <MODULE>, <DETAILS>
// and <USER_NAME> (the acting login). The drifted object is correlated
// CLIENT-SIDE by matching its name/id inside the free-text <DETAILS>/<ACTION>
// (Qualys has no structured resource id in the activity log). The chosen event
// maps to a DriftActor the platform stores as-is and the client renders; on any
// miss the diff is reported without an actor (the UI shows "—").
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, a non-OK response (e.g. the service
// account's role lacks Activity Log / API access), an empty log, or no usable
// human event it returns undefined and the diff is left unattributed. It NEVER
// fabricates.
//
// Veltrix's own deploys run through the connection's Qualys service account, so
// a change WE made is recorded under that account's login. To attribute the
// MANUAL change (not our own deploy), the caller passes the connection login(s)
// in `excludeActorLogins` (from `veltrixActorLogins`) and those events are
// skipped.
// =============================================================================

import { xmlBlocks, xmlText, type QualysClient } from '../../lib/qualys'

/** Attribution attached to a drifted diff — mirrors the SDK's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** A single User Activity Log entry (only the fields we read). */
export interface QualysActivityEvent {
  /** <USER_NAME> — the acting Qualys login. */
  user?: string
  /** <DATE> — when the action occurred (ISO-ish timestamp). */
  date?: string
  /** <ACTION> — the action verb (e.g. "create", "update", "delete"). */
  action?: string
  /** <MODULE> — the Qualys module the action belongs to. */
  module?: string
  /** <DETAILS> — free-text description that names the affected object. */
  details?: string
}

export interface ResolveDriftActorOptions {
  /** Live Qualys object id — matched (as a substring) against the entry text. */
  targetId?: string
  /** Object name/title — matched (as a substring) against the entry text. */
  targetName?: string
  /** Qualys `since_datetime` lower bound for the log window; defaults to ~7 days ago. */
  since?: string
  /** Connection login(s) to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Path for the classic v2 User Activity Log API. */
export const ACTIVITY_LOG_PATH = '/api/2.0/fo/activity_log/'
/** Default look-back window for the activity query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** The API returns most-recent first; a small page finds the last human change. */
const ACTIVITY_TRUNCATION_LIMIT = 50

/**
 * Substrings of an `ACTION` that represent a user-driven CHANGE. `pickActor`
 * prefers these; if none match it falls back to the most recent human,
 * non-Veltrix event so attribution stays best-effort. Qualys activity-log
 * actions are short lower-case verbs (e.g. "create", "update", "delete").
 */
const CHANGE_ACTION_KEYWORDS = [
  'create',
  'update',
  'delete',
  'add',
  'remove',
  'edit',
  'modify',
  'change',
  'set',
  'activate',
  'deactivate',
  'enable',
  'disable',
]

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** True when the event has an acting login — the activity log's only actor form. */
function isHumanActor(event: QualysActivityEvent): boolean {
  return typeof event.user === 'string' && event.user.trim() !== ''
}

/** True when the event's actor is one of the excluded (Veltrix) logins. */
function isExcludedActor(event: QualysActivityEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const user = normalizeLogin(event.user)
  return user !== '' && excluded.has(user)
}

/** True when the action looks like a change to a managed object. */
function isChangeEvent(action: string | undefined): boolean {
  const t = normalizeLogin(action)
  if (t === '') return false
  return CHANGE_ACTION_KEYWORDS.some((keyword) => t.includes(keyword))
}

/** True when an entry's free text names the drifted object (by live id or name). */
function eventMatchesTarget(
  event: QualysActivityEvent,
  targetId: string | undefined,
  targetName: string | undefined,
): boolean {
  const haystack = `${event.details ?? ''} ${event.action ?? ''}`.toLowerCase()
  if (haystack.trim() === '') return false
  const id = (targetId ?? '').trim().toLowerCase()
  const name = (targetName ?? '').trim().toLowerCase()
  if (id !== '' && haystack.includes(id)) return true
  if (name !== '' && haystack.includes(name)) return true
  return false
}

/** Map a chosen activity entry to the DriftActor shape (only defined fields kept). */
function toActor(event: QualysActivityEvent): DriftActor {
  const actor: DriftActor = { source: 'qualys-audit' }
  const user = typeof event.user === 'string' ? event.user.trim() : ''
  // The activity log identifies the actor by login only — use it for the name.
  if (user) actor.name = user
  if (event.date) actor.at = event.date
  if (event.action) actor.eventType = event.action
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live activity-log call. Considers only events with an
 * acting login, non-excluded, and sorts by `date` DESCENDING so it is
 * order-independent. Prefers a change-type action; if none match, falls back to
 * the most recent human, non-excluded event. Returns undefined when nothing
 * usable remains. Callers pass events ALREADY correlated to the target.
 */
export function pickActorFromEvents(
  events: QualysActivityEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns most-recent first, but sort defensively.
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event.action))
  return toActor(preferred ?? candidates[0])
}

/** Parse a User Activity Log XML document into the events we read — never throws. */
export function parseActivityEvents(xml: string): QualysActivityEvent[] {
  return xmlBlocks(xml, 'USER_ACTIVITY_LOG').map((block) => ({
    user: xmlText(block, 'USER_NAME'),
    date: xmlText(block, 'DATE'),
    action: xmlText(block, 'ACTION'),
    module: xmlText(block, 'MODULE'),
    details: xmlText(block, 'DETAILS'),
  }))
}

/** Format an ISO timestamp for Qualys `since_datetime` (no fractional seconds). */
function toQualysDatetime(iso: string): string {
  return iso.replace(/\.\d{3}(?=Z$)/, '')
}

/**
 * Resolve WHO last manually changed a drifted Qualys object and WHEN, from the
 * User Activity Log. Fetches one page of recent entries (since ~7d), correlates
 * them to the target by matching its name/id inside the entry text, and picks
 * the last human non-Veltrix change. Best-effort: returns undefined when neither
 * a target id nor name is given, on any error, a non-OK response (e.g. the
 * account lacks Activity Log access), an empty log, or no usable human event —
 * attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: QualysClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    if (!opts.targetId && !opts.targetName) return undefined

    const since = opts.since ?? toQualysDatetime(new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString())
    const res = await client.post(ACTIVITY_LOG_PATH, {
      action: 'list',
      output_format: 'XML',
      since_datetime: since,
      truncation_limit: ACTIVITY_TRUNCATION_LIMIT,
    })
    if (!res.ok) return undefined

    const events = parseActivityEvents(res.body)
    const correlated = events.filter((event) =>
      eventMatchesTarget(event, opts.targetId, opts.targetName),
    )
    return pickActorFromEvents(correlated, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op (no query) when there are no diffs, and unattributed
 * when no actor is resolved. Kept here so all driftDetect handlers wire
 * attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: QualysClient,
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
 * login our own changes appear under in the activity log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
