// =============================================================================
// Tenable Vulnerability Management — drift attribution ("who changed it + when").
//
// When a config type detects that a live Tenable object has drifted from its
// deployed state, this resolves WHO made the last change and WHEN by querying
// the Tenable.io Audit Log (GET /audit-log/v1/events). The chosen event is
// mapped to an optional `actor` attached to each drifted diff, which the
// platform stores as-is and the client renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, a non-OK response, an empty log, an
// admin-only 403, or no usable event, it returns undefined and the diff is
// reported without an actor (the UI shows "—").
//
// Tenable's audit log does not expose an actor `type`, so we cannot positively
// tell a human from a service principal; we treat any named, non-Veltrix actor
// as attributable (best-effort) and never fabricate an identity.
//
// Veltrix's own deploys authenticate with the connection's API key pair, so a
// change WE made is recorded under that identity. To attribute the MANUAL change
// (not our own deploy), the caller passes the connection identity in
// `excludeActorLogins` and events by that actor are skipped.
// =============================================================================

import { parseJson, type TenableClient } from '../../lib/tenable'

/** Attribution attached to a drifted diff — mirrors the SDK's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** An audit-log actor/target principal (the fields we read). */
interface AuditLogPrincipal {
  id?: string
  name?: string
  type?: string
}

/** A single Tenable audit-log event (only the fields we read). */
export interface AuditLogEvent {
  id?: string
  /** ISO timestamp of when the event occurred. */
  received?: string
  /** Dotted action name, e.g. "scan.update". */
  action?: string
  /** CRUD marker: 'c' create, 'u' update, 'd' delete, 'r' read. */
  crud?: string
  actor?: AuditLogPrincipal
  target?: AuditLogPrincipal
  /** True when the acting principal could not be identified. */
  is_anonymous?: boolean
}

/** The GET /audit-log/v1/events envelope. */
interface AuditLogResponse {
  events?: AuditLogEvent[]
}

export interface ResolveDriftActorOptions {
  /** Tenable object id — the most reliable correlation key when known. */
  targetId?: string | number
  /** Object name — the correlation fallback (and the only key for a deleted object). */
  targetName?: string
  /** ISO date (yyyy-mm-dd) lower bound for the log window; defaults to ~7 days ago. */
  sinceDate?: string
  /** Connection identity(ies) to skip — Veltrix's own deploy. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the log query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** A small page is enough to find the last change to a single correlated object. */
const AUDIT_LOG_LIMIT = 50
/** CRUD markers that represent a WRITE (a change) rather than a read. */
const CHANGE_CRUD = new Set(['c', 'u', 'd'])
/** Fallback change signal when an event carries no crud marker. */
const CHANGE_ACTION_RE = /(create|update|delete|edit|modif|enable|disable|add|remove|configure|assign)/i
/** Loose email shape — a Tenable audit actor name is usually the user's email. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** yyyy-mm-dd for a Date (the audit-log `date.gt` filter is date-granular). */
function toDateFilter(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** True when the event has an identifiable, non-anonymous acting principal. */
function hasIdentifiableActor(event: AuditLogEvent): boolean {
  if (event.is_anonymous === true) return false
  const name = typeof event.actor?.name === 'string' ? event.actor.name.trim() : ''
  const id = typeof event.actor?.id === 'string' ? event.actor.id.trim() : ''
  return name !== '' || id !== ''
}

/** True when the event's actor is one of the excluded (Veltrix) identities. */
function isExcludedActor(event: AuditLogEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const name = normalize(event.actor?.name)
  const id = normalize(event.actor?.id)
  return (name !== '' && excluded.has(name)) || (id !== '' && excluded.has(id))
}

/** True when the event represents a write (create/update/delete) to the object. */
function isChangeEvent(event: AuditLogEvent): boolean {
  const crud = normalize(event.crud)
  if (crud !== '') return CHANGE_CRUD.has(crud)
  return CHANGE_ACTION_RE.test(event.action ?? '')
}

/** Map a chosen audit event to the DriftActor shape (only defined fields kept). */
function toActor(event: AuditLogEvent): DriftActor {
  const actor: DriftActor = { source: 'tenable-audit' }
  const id = typeof event.actor?.id === 'string' ? event.actor.id.trim() : ''
  const name = typeof event.actor?.name === 'string' ? event.actor.name.trim() : ''
  if (id) actor.id = id
  if (name) actor.name = name
  if (name && EMAIL_RE.test(name)) actor.email = name
  if (event.received) actor.at = event.received
  if (event.action) actor.eventType = event.action
  return actor
}

/**
 * True when an event targets the drifted object. Matches on target id (the
 * reliable key) when both are known, else on a normalized target-name equality.
 */
export function eventMatchesTarget(
  event: AuditLogEvent,
  targetId: string | number | undefined,
  targetName: string | undefined,
): boolean {
  const wantId = targetId !== undefined && targetId !== null ? String(targetId).trim().toLowerCase() : ''
  const wantName = normalize(targetName)
  const haveId = normalize(event.target?.id)
  const haveName = normalize(event.target?.name)
  if (wantId !== '' && haveId !== '' && haveId === wantId) return true
  if (wantName !== '' && haveName !== '' && haveName === wantName) return true
  return false
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live audit-log call. The `events` passed in are assumed to
 * be already correlated to ONE drifted object. Considers only events with an
 * identifiable, non-excluded actor, and sorts by `received` DESCENDING so it is
 * order-independent. Prefers a change (create/update/delete) event; if none
 * qualifies, falls back to the most recent identifiable event. Returns undefined
 * when nothing usable remains.
 */
export function pickActorFromEvents(
  events: AuditLogEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalize).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => hasIdentifiableActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — sort defensively so input order does not matter.
    .sort((a, b) => (b.received ?? '').localeCompare(a.received ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event))
  return toActor(preferred ?? candidates[0])
}

/**
 * Resolve WHO last changed a drifted Tenable object and WHEN, from the Audit
 * Log. Reads one recent page (GET /audit-log/v1/events?f=date.gt:<yyyy-mm-dd>),
 * correlates the events to this object by target id/name, then picks the actor.
 * Best-effort: returns undefined on any error, a non-OK response (the audit log
 * needs an admin key and returns 403 otherwise), an empty/malformed body, or no
 * correlated event — attribution never throws or fails a drift check. Returns
 * undefined without querying when neither a target id nor name is known.
 */
export async function resolveDriftActor(
  client: TenableClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  const hasId = opts.targetId !== undefined && opts.targetId !== null && String(opts.targetId).trim() !== ''
  const hasName = typeof opts.targetName === 'string' && opts.targetName.trim() !== ''
  if (!hasId && !hasName) return undefined

  try {
    const sinceDate = opts.sinceDate ?? toDateFilter(Date.now() - DEFAULT_LOOKBACK_MS)
    const res = await client.request('GET', '/audit-log/v1/events', {
      query: { f: `date.gt:${sinceDate}`, limit: AUDIT_LOG_LIMIT },
    })
    if (!res.ok) return undefined

    const parsed = parseJson<AuditLogResponse>(res.body)
    const events = Array.isArray(parsed?.events) ? (parsed as AuditLogResponse).events ?? [] : []
    const correlated = events.filter((event) => eventMatchesTarget(event, opts.targetId, opts.targetName))

    return pickActorFromEvents(correlated, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so all the driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: TenableClient,
  diffs: object[],
  opts: ResolveDriftActorOptions,
): Promise<void> {
  if (!diffs || diffs.length === 0) return
  const actor = await resolveDriftActor(client, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The connection identity(ies) to treat as Veltrix (excluded from attribution).
 * The credential's username is the Tenable access key our deploys authenticate
 * with, so it is the identity our own changes are recorded under.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
