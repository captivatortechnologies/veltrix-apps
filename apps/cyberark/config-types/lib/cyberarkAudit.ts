// =============================================================================
// CyberArk PVWA — drift attribution ("who changed it + when").
//
// When a config type detects that a live PVWA object has drifted from its
// deployed state, this resolves WHO made the last change and WHEN. CyberArk
// exposes two attribution sources, and this module reads whichever fits the
// drifted object:
//
//   - ACCOUNTS: the per-account Activities log (GET /Accounts/{id}/Activities)
//     records every action with its `User`, `Date` (epoch) and `Action`. This is
//     the richest source (it names the human who last changed the account) and is
//     read via `pickActorFromEvents`, most-recent-change-first.
//   - SAFES: a live safe carries its `creator` (principal), `creationTime` and
//     `lastModificationTime` DIRECTLY on the object the drift check already
//     fetched, so `pickActorFromResource` reads them with no extra API call.
//     CyberArk records only the creator identity on a safe (not a distinct
//     last-modifier), so a safe is attributed to its creator — the closest
//     attribution the Gen2 API affords — with `at` reflecting the safe's last
//     modification time.
//   - SAFE MEMBERS: the Gen2 member object carries no creator/modifier metadata
//     and there is no per-member activity endpoint, so member diffs cannot be
//     attributed with the app's credentials — they are reported without an actor
//     and the drift view shows "—".
//
// STRICTLY BEST-EFFORT: every entry point returns undefined rather than throwing,
// so attribution can NEVER break a drift check. On any error, an empty log, a
// missing source, or no usable human event, the diff is reported without an
// actor.
//
// Veltrix's own deploys run through the connection's manager account, so a change
// WE made is recorded under that account's username. To attribute the MANUAL
// change (not our own deploy), the caller passes the connection username in
// `excludeActorLogins` and an object last written by us is left unattributed.
// =============================================================================

import { parseJson, type CyberArkClient } from '../../lib/cyberark'

/** Attribution attached to a drifted diff — mirrors the SDK's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

// --- Accounts: per-account Activities log (event source) ---------------------

/** One activity record from GET /Accounts/{id}/Activities (only fields we read). */
export interface AccountActivity {
  /** The login that performed the action — the WHO. */
  User?: string
  /** Unix epoch (seconds) the action occurred — the WHEN. */
  Date?: number
  /** Free-text action description (e.g. "Modify object properties") — the WHAT. */
  Action?: string
  Alert?: boolean
}

/** Envelope shapes the Activities endpoint may wrap its records in. */
interface ActivitiesEnvelope {
  Activities?: AccountActivity[]
  GetAccountActivitiesResult?: AccountActivity[]
  value?: AccountActivity[]
}

// --- Safes: resource-embedded creator (resource source) ----------------------

/** A principal recorded on a live safe (its creator). */
export interface CyberArkPrincipal {
  id?: string | number
  name?: string
  source?: string
}

/** Fields read off a live PVWA resource (a safe) for resource-embedded attribution. */
export interface CyberArkResource {
  creator?: CyberArkPrincipal
  /** Epoch the object was created. Seconds, ms or microseconds — normalised on read. */
  creationTime?: number
  /** Epoch the object was last modified. Seconds, ms or microseconds — normalised. */
  lastModificationTime?: number
}

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** Loose email shape — an activity `User` or safe creator may be an email or a login. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Actions that represent a MANUAL change to a managed field (preferred when
 * picking an activity). A first pass prefers these; if none match, attribution
 * falls back to the most recent human, non-automated activity so it stays
 * best-effort.
 */
const CHANGE_ACTION_PATTERNS = [
  /modif/i, // "Modify object properties"
  /\bupdate/i,
  /\badd\b/i,
  /\brename/i,
  /\bchange\b/i,
  /activat/i, // activate / deactivate management
  /\benable/i,
  /\bdisable/i,
  /\bdelete/i,
  /\bremove/i,
  /properties/i,
]

/**
 * Actions performed by the CPM component (automated credential rotation, verify,
 * reconcile). Excluded so attribution reflects a HUMAN change, not the vault's
 * own automation, which is recorded under the CPM component user.
 */
const AUTOMATED_ACTION_PATTERNS = [/^\s*CPM\b/i, /\bby CPM\b/i]

const matchesAny = (patterns: RegExp[], action: string | undefined): boolean => {
  const text = action ?? ''
  return patterns.some((re) => re.test(text))
}

const isChangeAction = (action: string | undefined): boolean =>
  matchesAny(CHANGE_ACTION_PATTERNS, action)

const isAutomatedAction = (action: string | undefined): boolean =>
  matchesAny(AUTOMATED_ACTION_PATTERNS, action)

/**
 * Normalise a CyberArk epoch to an ISO-8601 string. PVWA reports timestamps in
 * seconds (activities, `creationTime`) or, on some builds, milliseconds /
 * microseconds (`lastModificationTime`); the magnitude is used to pick the unit.
 * Returns undefined for a missing / non-positive / invalid value.
 */
export function epochToIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  let ms: number
  if (value >= 1e15)
    ms = value / 1000 // microseconds → milliseconds
  else if (value >= 1e12)
    ms = value // already milliseconds
  else ms = value * 1000 // seconds → milliseconds
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Map a chosen activity to the DriftActor shape (only defined fields kept). */
function toActorFromActivity(activity: AccountActivity): DriftActor {
  const user = typeof activity.User === 'string' ? activity.User.trim() : ''
  const actor: DriftActor = { source: 'cyberark-audit', name: user }
  if (EMAIL_RE.test(user)) actor.email = user
  const at = epochToIso(activity.Date)
  if (at) actor.at = at
  const action = typeof activity.Action === 'string' ? activity.Action.trim() : ''
  if (action) actor.eventType = action
  return actor
}

/**
 * Pick the actor of the most relevant account activity — PURE, so it is
 * unit-testable in isolation from the live Activities call. Considers only
 * activities with a non-empty `User` that is neither an excluded (Veltrix) login
 * nor an automated CPM action, sorts by `Date` DESCENDING (order-independent),
 * prefers a change-type action and otherwise falls back to the most recent
 * remaining activity. Returns undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  activities: AccountActivity[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(activities) || activities.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = activities
    .filter((activity) => {
      const user = typeof activity.User === 'string' ? activity.User.trim() : ''
      if (user === '') return false
      if (excluded.has(user.toLowerCase())) return false
      if (isAutomatedAction(activity.Action)) return false
      return true
    })
    // Most recent first — sort defensively (the API order is not guaranteed).
    .sort((a, b) => (b.Date ?? 0) - (a.Date ?? 0))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((activity) => isChangeAction(activity.Action))
  return toActorFromActivity(preferred ?? candidates[0])
}

/**
 * Pick the actor from a live safe's creator field — PURE, so it is unit-testable
 * in isolation. Returns undefined when there is no creator identity, or when the
 * creator is an excluded (Veltrix) login, so a safe we created ourselves is never
 * mis-attributed as a manual change. `at` reflects the safe's last-modification
 * time (falling back to its creation time); `name` carries the creator, the only
 * identity CyberArk records on a safe.
 */
export function pickActorFromResource(
  resource: CyberArkResource | null | undefined,
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!resource || typeof resource !== 'object') return undefined

  const creator = resource.creator
  if (!creator || typeof creator !== 'object') return undefined

  const name = typeof creator.name === 'string' ? creator.name.trim() : ''
  const id = creator.id !== undefined && creator.id !== null ? String(creator.id).trim() : ''
  const who = name || id
  if (who === '') return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))
  if ((name && excluded.has(name.toLowerCase())) || (id && excluded.has(id.toLowerCase()))) {
    return undefined
  }

  const actor: DriftActor = { source: 'cyberark-audit', name: who }
  if (id && id !== who) actor.id = id
  if (EMAIL_RE.test(who)) actor.email = who

  const modifiedAt = epochToIso(resource.lastModificationTime)
  const createdAt = epochToIso(resource.creationTime)
  if (modifiedAt) {
    actor.at = modifiedAt
    actor.eventType = 'safe.modified'
  } else if (createdAt) {
    actor.at = createdAt
    actor.eventType = 'safe.created'
  } else {
    actor.eventType = 'safe.created'
  }
  return actor
}

export interface ResolveDriftActorOptions {
  /** Account id → fetch GET /Accounts/{id}/Activities (accounts). */
  accountId?: string
  /** A live PVWA resource carrying creator/timestamps (safes). */
  resource?: CyberArkResource | null
  /** Connection login(s) to skip — Veltrix's own deploy identity. */
  excludeActorLogins?: string[]
}

/** Fetch and unwrap an account's activity log — [] on any non-OK / parse issue. */
async function fetchAccountActivities(
  client: CyberArkClient,
  accountId: string,
): Promise<AccountActivity[]> {
  const res = await client.request('GET', `/Accounts/${encodeURIComponent(accountId)}/Activities`)
  if (!res.ok) return []
  const parsed = parseJson<AccountActivity[] | ActivitiesEnvelope>(res.body)
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.Activities)) return parsed.Activities
    if (Array.isArray(parsed.GetAccountActivitiesResult)) return parsed.GetAccountActivitiesResult
    if (Array.isArray(parsed.value)) return parsed.value
  }
  return []
}

/**
 * Resolve WHO last changed a drifted CyberArk object and WHEN. Reads the
 * resource-embedded creator first (a safe — no extra API call), then the
 * per-account Activities log (an account). Best-effort: returns undefined on any
 * error, missing source, or no usable event — attribution never throws or fails a
 * drift check.
 */
export async function resolveDriftActor(
  client: CyberArkClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const exclude = opts.excludeActorLogins ?? []

    // Resource-embedded attribution first — no extra API call (safes).
    if (opts.resource) {
      const fromResource = pickActorFromResource(opts.resource, exclude)
      if (fromResource) return fromResource
    }

    // Per-account Activities log (accounts).
    if (opts.accountId) {
      const activities = await fetchAccountActivities(client, opts.accountId)
      return pickActorFromEvents(activities, exclude)
    }

    return undefined
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so all three driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: CyberArkClient,
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
 * identity our own changes are recorded under in the activity log / creator field.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
