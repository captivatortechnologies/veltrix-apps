// =============================================================================
// SentinelOne activity log — drift attribution ("who changed it + when").
//
// When a config type detects that a live SentinelOne object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the SentinelOne Activities API
// (GET /web/api/v2.1/activities). The result is attached to each drifted diff as
// an optional `actor`, which the platform stores as-is and the client renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty log, or no usable human
// event, it returns undefined and the diff is reported without an actor (the UI
// shows "—").
//
// SentinelOne activities carry no first-class "target object id" filter that is
// reliable across every managed object type, so attribution correlates each
// activity to the drifted object CLIENT-SIDE: an activity matches when the
// object's id or name/value appears in the activity's scope ids, `data` payload
// or descriptions. Uncorrelated activities are dropped, so an unrelated change is
// never mis-attributed.
//
// Veltrix's own deploys authenticate with the connection's SentinelOne service
// user (API token), so those activities carry that user as the actor. The
// connection's username is passed in `excludeActorLogins` and any activity whose
// actor id / display name matches is skipped, so attribution reflects the MANUAL
// change, not our own deploy.
//
// NOTE ON TYPES: sentinelone typechecks against an SDK build whose `DriftDiff`
// has no `actor` field, so this module declares its OWN `DriftActor` (it never
// imports one from the SDK) and sets the field STRUCTURALLY on an `object[]`,
// adding zero new tsc errors.
// =============================================================================

import { parseJson, type S1Client, type S1Envelope } from './s1'

/** Attribution attached to a drifted diff (a local shape — see the type note above). */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** A single SentinelOne activity (only the fields we read). */
export interface S1Activity {
  id?: string
  activityType?: number | string
  createdAt?: string
  primaryDescription?: string | null
  secondaryDescription?: string | null
  /** The id of the user who performed the action (null/absent for system events). */
  userId?: string | number | null
  /** Contextual payload — carries the display name and object references. */
  data?: Record<string, unknown> | null
  groupId?: string | null
  siteId?: string | null
  accountId?: string | null
}

export interface ResolveDriftActorOptions {
  /** The drifted object's SentinelOne id — the strongest correlation token. */
  targetId?: string
  /** The object's name/value (group name, rule name, exclusion value, hash). */
  targetName?: string
  /** ISO lower bound for the activity window; defaults to ~7 days ago. */
  since?: string
  /** Connection service-user identity to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the activity query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** The list is DESCENDING by createdAt — a single page finds the last human change. */
const ACTIVITY_LIMIT = 50
/** Correlation tokens shorter than this are ignored (too noisy to match on). */
const MIN_TOKEN_LENGTH = 2

/**
 * primaryDescription keywords that mark a user-driven CHANGE (not a login/read).
 * A `pickActor` first pass prefers these; if none match it falls back to the most
 * recent human, non-Veltrix event so attribution is still best-effort.
 */
const CHANGE_EVENT_HINTS = [
  'created',
  'added',
  'updated',
  'modified',
  'edited',
  'changed',
  'deleted',
  'removed',
  'enabled',
  'disabled',
  'saved',
  'set ',
  'assigned',
]

/** Payload keys that commonly carry the acting user's display name. */
const USER_NAME_KEYS = ['username', 'userName', 'byUser', 'fullName', 'fullname', 'user']

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** The acting user's id as a trimmed string ('' when the activity is system-generated). */
function actorUserId(activity: S1Activity): string {
  const raw = activity.userId
  if (typeof raw === 'string') return raw.trim()
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return ''
}

/** The acting user's display name from the activity payload ('' when absent). */
function actorUserName(activity: S1Activity): string {
  const data = activity.data
  if (data && typeof data === 'object') {
    for (const key of USER_NAME_KEYS) {
      const value = (data as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return ''
}

/** True when the activity was performed by an identifiable human user. */
function isHumanActor(activity: S1Activity): boolean {
  return actorUserId(activity) !== '' || actorUserName(activity) !== ''
}

/** True when the activity's actor is one of the excluded (Veltrix) identities. */
function isExcludedActor(activity: S1Activity, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const id = normalize(actorUserId(activity))
  const name = normalize(actorUserName(activity))
  return (id !== '' && excluded.has(id)) || (name !== '' && excluded.has(name))
}

/** True when the activity's description looks like a change to a managed object. */
function isChangeEvent(activity: S1Activity): boolean {
  const haystack = `${normalize(activity.primaryDescription)} ${normalize(activity.secondaryDescription)}`
  return CHANGE_EVENT_HINTS.some((hint) => haystack.includes(hint))
}

/** Map a chosen activity to the DriftActor shape (only defined fields kept). */
function toActor(activity: S1Activity): DriftActor {
  const actor: DriftActor = { source: 'sentinelone-audit' }
  const id = actorUserId(activity)
  const name = actorUserName(activity)
  if (id) actor.id = id
  if (name) {
    actor.name = name
    if (name.includes('@')) actor.email = name
  } else if (id) {
    // No display name in the payload — fall back to the user id, per the contract.
    actor.name = id
  }
  if (activity.createdAt) actor.at = activity.createdAt
  const description =
    (typeof activity.primaryDescription === 'string' && activity.primaryDescription.trim()) || ''
  const eventType =
    description || (activity.activityType != null ? `activity ${activity.activityType}` : '')
  if (eventType) actor.eventType = eventType
  return actor
}

/**
 * Pick the actor of the most relevant activity — PURE, so it is unit-testable in
 * isolation from the live Activities call. Considers only human (an identifiable
 * user), non-excluded activities, and (defensively) sorts by `createdAt`
 * DESCENDING so it is order-independent. Prefers a change-type description; if
 * none match, falls back to the most recent human, non-excluded activity. Returns
 * undefined when nothing usable remains.
 *
 * Callers correlate the activities to the drifted object BEFORE calling this, so
 * every event passed here is already known to reference the target.
 */
export function pickActorFromEvents(
  events: S1Activity[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalize).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns DESCENDING, but sort defensively.
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event))
  return toActor(preferred ?? candidates[0])
}

/** The normalized, non-trivial correlation tokens for a target (id + name/value). */
function correlationTokens(opts: ResolveDriftActorOptions): string[] {
  return [opts.targetId, opts.targetName]
    .map(normalize)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH)
}

/** The searchable strings of an activity: its scope ids, descriptions and `data` values. */
function activityHaystack(activity: S1Activity): string[] {
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) parts.push(value.trim().toLowerCase())
    else if (typeof value === 'number' && Number.isFinite(value)) parts.push(String(value))
  }
  push(activity.groupId)
  push(activity.siteId)
  push(activity.accountId)
  push(activity.primaryDescription)
  push(activity.secondaryDescription)
  const data = activity.data
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) push(value)
  }
  return parts
}

/** True when an activity references the target object by any correlation token. */
function activityMatchesTarget(activity: S1Activity, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const haystack = activityHaystack(activity)
  return tokens.some((token) => haystack.some((entry) => entry === token || entry.includes(token)))
}

/**
 * Resolve WHO last manually changed a drifted SentinelOne object and WHEN, from
 * the Activities API. Pulls a recent page of activities (createdAt DESCENDING,
 * last ~7 days), correlates them to the target CLIENT-SIDE (by id or name/value
 * in the activity's scope ids / `data` / descriptions) so an unrelated object's
 * change is never attributed, then picks the most recent human, non-Veltrix
 * change. Best-effort: returns undefined on any error, an empty log, or no usable
 * human event — attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: S1Client,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const tokens = correlationTokens(opts)
    if (tokens.length === 0) return undefined

    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const res = await client.request('GET', '/activities', {
      query: {
        limit: ACTIVITY_LIMIT,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        createdAt__gte: since,
      },
    })
    if (!res.ok) return undefined

    const env = parseJson<S1Envelope<S1Activity[]>>(res.body)
    const activities = env?.data
    if (!Array.isArray(activities)) return undefined

    const correlated = activities.filter((activity) => activityMatchesTarget(activity, tokens))
    return pickActorFromEvents(correlated, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so all six driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even though the SDK build's `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: S1Client,
  diffs: object[],
  opts: ResolveDriftActorOptions,
): Promise<void> {
  if (!diffs || diffs.length === 0) return
  const actor = await resolveDriftActor(client, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The connection identity to exclude from attribution. SentinelOne deploys
 * authenticate with the connection's API token — a service user — so the
 * credential's `username` is the identity our own changes appear under in the
 * activity log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
