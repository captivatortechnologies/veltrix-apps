// =============================================================================
// Cortex XSOAR Audit Trail — drift attribution ("who changed it + when").
//
// When a config type detects that a live XSOAR object (a list, incident type or
// scheduled job) has drifted from its deployed state, this resolves WHO made the
// last manual change and WHEN. Two best-effort sources, in order:
//
//   1. Modifier fields ON the drifted object. Many XSOAR content objects carry a
//      `modifiedBy` (username) alongside a `modified` timestamp. When the live
//      object names a non-Veltrix, non-system modifier, it is used directly — no
//      extra request. PREFERRED because it is the object's own record of its last
//      writer.
//   2. The server AUDIT TRAIL — `POST /settings/audits` with a filter body
//      (`{ page, size, fromDate: <~7d> }`). Entries carry `user`/`userName`,
//      `created`/`modified`, an `action` and the changed entity's name/id. They
//      are correlated CLIENT-SIDE to the drifted object by its NAME (XSOAR keys
//      lists/incident-types/jobs by name) or id, and the most recent human,
//      non-Veltrix change wins.
//
// The chosen event maps to a DriftActor the platform stores as-is on each diff
// and the client renders; on any miss the diff is reported without an actor (the
// UI shows "—").
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, a non-OK response (e.g. the API key
// lacks audit-read permission), an empty log, or no usable human event it returns
// undefined and the diff is left unattributed. It NEVER fabricates.
//
// Veltrix's own deploys run through the connection's API key, so a change WE made
// is recorded under that key's identity. To attribute the MANUAL change (not our
// own deploy), the caller passes the connection login(s) in `excludeActorLogins`
// (from `veltrixActorLogins`) and those events are skipped; XSOAR's own automation
// user ("DBot") is skipped as a non-human system actor.
// =============================================================================

import { parseJson, type XsoarClient } from '../../lib/xsoar'

/** Attribution attached to a drifted diff — LOCAL shape (the SDK's DriftDiff has no `actor`). */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** The single attribution source label carried on every actor this module produces. */
const ACTOR_SOURCE = 'xsoar-audit'

/**
 * A single XSOAR audit-trail entry (only the fields we read). XSOAR spells these
 * inconsistently across versions, so each is read defensively from a few aliases.
 */
export interface XsoarAuditEntry {
  /** Acting user's login/id. */
  user?: string
  userId?: string
  /** Acting user's display name. */
  userName?: string
  /** Acting user's email, when the audit record carries one. */
  email?: string
  userEmail?: string
  /** When the audited action happened (preferred), then modified/timestamp. */
  created?: string
  modified?: string
  timestamp?: string
  /** The action performed (e.g. "update", "delete", "create"). */
  action?: string
  /** The changed entity's TYPE (e.g. "list") — NOT used for name correlation. */
  entity?: string
  /** The changed entity's name / id — used to correlate to the drifted object. */
  entityName?: string
  name?: string
  objectName?: string
  identifier?: string
  entityID?: string
}

export interface ResolveDriftActorOptions {
  /** Live XSOAR object id — matched against the audit entry's entity id. */
  targetId?: string
  /** Object name (the XSOAR identity) — matched against the audit entry's entity name. */
  targetName?: string
  /** The live drifted object itself — checked for `modifiedBy`/`modified` first. */
  resource?: object | null
  /** ISO lower bound for the audit window; defaults to ~7 days ago. */
  since?: string
  /** Connection login(s) to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the audit query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** One page is enough to find the last human change in the recent window. */
const AUDIT_PAGE_SIZE = 100

/** XSOAR's built-in automation user — a system principal, never a human change. */
const SYSTEM_ACTORS = new Set(['dbot'])

/**
 * Substrings of an `action` that represent a user-driven CHANGE. `pickActor`
 * prefers these; if none match it falls back to the most recent human,
 * non-Veltrix event so attribution stays best-effort.
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
  'save',
  'install',
  'enable',
  'disable',
  'upload',
]

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** The acting user's display-ish name from an entry (userName preferred, then user). */
function entryActorName(entry: XsoarAuditEntry): string {
  return readString(entry.userName) || readString(entry.user)
}

/** When the audited action happened — created (the action time), then modified/timestamp. */
function entryTimestamp(entry: XsoarAuditEntry): string {
  return readString(entry.created) || readString(entry.timestamp) || readString(entry.modified)
}

/** True when the entry's actor is a human user (named, and not a system principal). */
function isHumanActor(entry: XsoarAuditEntry): boolean {
  const name = normalizeLogin(entryActorName(entry))
  return name !== '' && !SYSTEM_ACTORS.has(name)
}

/** True when the entry's actor is one of the excluded (Veltrix) logins. */
function isExcludedActor(entry: XsoarAuditEntry, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const candidates = [
    normalizeLogin(entry.user),
    normalizeLogin(entry.userName),
    normalizeLogin(entry.userId),
  ]
  return candidates.some((c) => c !== '' && excluded.has(c))
}

/** True when the action looks like a change to a managed object. */
function isChangeEvent(action: string | undefined): boolean {
  const a = normalizeLogin(action)
  if (a === '') return false
  return CHANGE_ACTION_KEYWORDS.some((keyword) => a.includes(keyword))
}

/**
 * True when an audit entry refers to the drifted object, correlated by NAME (the
 * XSOAR identity) or id. The entity TYPE (`entity`) is deliberately excluded to
 * avoid false-matching a target name against a type like "list".
 */
function entryMatchesTarget(
  entry: XsoarAuditEntry,
  targetId: string | undefined,
  targetName: string | undefined,
): boolean {
  const names = [entry.entityName, entry.name, entry.objectName, entry.identifier].map(normalizeLogin)
  const ids = [entry.entityID, entry.identifier].map(normalizeLogin)
  const id = normalizeLogin(targetId)
  const name = normalizeLogin(targetName)
  if (id !== '' && ids.includes(id)) return true
  if (name !== '' && names.includes(name)) return true
  return false
}

/** Map a chosen audit entry to the DriftActor shape (only defined fields kept). */
function toActor(entry: XsoarAuditEntry): DriftActor {
  const actor: DriftActor = { source: ACTOR_SOURCE }
  const id = readString(entry.userId) || readString(entry.user)
  const name = readString(entry.userName) || readString(entry.user)
  const email = readString(entry.userEmail) || readString(entry.email)
  if (id) actor.id = id
  if (name) actor.name = name
  if (email) actor.email = email
  const at = entryTimestamp(entry)
  if (at) actor.at = at
  if (entry.action) actor.eventType = String(entry.action)
  return actor
}

/**
 * Pick the actor of the most relevant entry — PURE, so it is unit-testable in
 * isolation from the live audit call. Considers only human (named, non-system),
 * non-excluded entries, and sorts by timestamp DESCENDING so it is order
 * independent. Prefers a change-type action; if none match, falls back to the
 * most recent human, non-excluded entry. Returns undefined when nothing usable
 * remains. Callers pass entries ALREADY correlated to the target.
 */
export function pickActorFromEvents(
  events: XsoarAuditEntry[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((entry) => isHumanActor(entry) && !isExcludedActor(entry, excluded))
    // Most recent first — the API returns newest-first, but sort defensively.
    .sort((a, b) => entryTimestamp(b).localeCompare(entryTimestamp(a)))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((entry) => isChangeEvent(entry.action))
  return toActor(preferred ?? candidates[0])
}

// Modifier-field candidates on a live XSOAR object (checked before the audit call).
const MODIFIER_NAME_FIELDS = ['modifiedBy', 'modifiedByName', 'lastModifiedBy', 'modifyingUser']
const MODIFIER_TIME_FIELDS = ['modified', 'modifiedTime', 'updated', 'updatedDate']

/**
 * Resolve the actor from the drifted object's OWN modifier fields — PURE and
 * unit-testable. Returns undefined unless the object names a modifier that is a
 * real, non-system, non-Veltrix user (a Veltrix/system value means the object's
 * last write was our deploy or automation, so the caller falls back to the audit
 * trail to find the manual change instead). Never fabricates.
 */
export function pickActorFromResource(
  resource: object | null | undefined,
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!resource || typeof resource !== 'object') return undefined
  const record = resource as Record<string, unknown>

  let name = ''
  for (const field of MODIFIER_NAME_FIELDS) {
    const value = readString(record[field])
    if (value) {
      name = value
      break
    }
  }
  if (!name) return undefined

  const normalized = normalizeLogin(name)
  if (SYSTEM_ACTORS.has(normalized)) return undefined
  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))
  if (excluded.has(normalized)) return undefined

  const actor: DriftActor = { source: ACTOR_SOURCE, name, eventType: 'modified' }
  for (const field of MODIFIER_TIME_FIELDS) {
    const at = readString(record[field])
    if (at) {
      actor.at = at
      break
    }
  }
  return actor
}

/**
 * Resolve WHO last manually changed a drifted XSOAR object and WHEN. Prefers the
 * object's own `modifiedBy` field; otherwise fetches one recent page of the audit
 * trail (`POST /settings/audits`, since ~7d), correlates entries to the target by
 * name/id, and picks the last human non-Veltrix change. Best-effort: returns
 * undefined when neither a target id/name nor a resource is given, on any error,
 * a non-OK response, an empty log, or no usable human event — attribution never
 * throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: XsoarClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const excludeActorLogins = opts.excludeActorLogins ?? []

    // 1) Prefer the drifted object's own record of its last writer.
    const fromResource = pickActorFromResource(opts.resource, excludeActorLogins)
    if (fromResource) return fromResource

    // 2) Fall back to the audit trail, correlated to the object.
    if (!opts.targetId && !opts.targetName) return undefined

    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const res = await client.request('POST', '/settings/audits', {
      body: { page: 0, size: AUDIT_PAGE_SIZE, fromDate: since },
    })
    if (!res.ok) return undefined

    const entries = parseAuditEntries(res.body)
    const correlated = entries.filter((entry) =>
      entryMatchesTarget(entry, opts.targetId, opts.targetName),
    )
    return pickActorFromEvents(correlated, excludeActorLogins)
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Parse the `/settings/audits` response into a flat entry list. XSOAR returns
 * either a bare array or an envelope (`{ audits }` / `{ data }` / `{ total }`),
 * so both are handled; anything else yields an empty list.
 */
export function parseAuditEntries(body: string): XsoarAuditEntry[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as XsoarAuditEntry[]
  if (parsed && typeof parsed === 'object') {
    const env = parsed as { audits?: unknown; data?: unknown }
    if (Array.isArray(env.audits)) return env.audits as XsoarAuditEntry[]
    if (Array.isArray(env.data)) return env.data as XsoarAuditEntry[]
  }
  return []
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op (no query) when there are no diffs, and unattributed
 * when no actor is resolved. Kept here so all driftDetect handlers wire
 * attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site — the SDK's `DriftDiff` has no `actor` field, so the
 * field is set STRUCTURALLY here.
 */
export async function attachDriftActor(
  client: XsoarClient,
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
 * identity our own changes appear under in the audit trail.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
