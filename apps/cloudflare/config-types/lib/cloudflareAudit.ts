// =============================================================================
// Cloudflare Audit Logs — drift attribution ("who changed it + when").
//
// When a config type detects that a live Cloudflare object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the account Audit Logs API:
//   GET /accounts/{account_id}/audit_logs?since=<iso-7d>&per_page=50&direction=desc
// Each entry carries `actor { email, id, type }`, `when`, `action { type }` and
// `resource { type, id }`. The drifted object is correlated CLIENT-SIDE by
// `resource.id` (the live object id, or the setting key for zone settings). The
// chosen event maps to a DriftActor the platform stores as-is and the client
// renders; on any miss the diff is reported without an actor (the UI shows "—").
//
// The account id is resolved by the shared CloudflareClient (from the explicit
// `account_id` setting or the zone's owning account), so this reuses
// `client.account(...)` exactly like every other account-scoped call.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, a non-OK response (e.g. the token
// lacks Audit Logs read scope → 403), an empty log, or no usable human event it
// returns undefined and the diff is left unattributed. It NEVER fabricates.
//
// Veltrix's own deploys run through the connection's API token, so a change WE
// made is recorded under that token's identity. To attribute the MANUAL change
// (not our own deploy), the caller passes the connection login(s) in
// `excludeActorLogins` (from `veltrixActorLogins`) and those events are skipped;
// the human filter (`actor.type === 'user'` with an email) already excludes a
// non-user API-token actor.
// =============================================================================

import { parseJson, type CloudflareClient, type CloudflareEnvelope } from '../../lib/cloudflare'

/** Attribution attached to a drifted diff — mirrors the SDK's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** An audit-log actor principal (the fields we read). */
interface AuditActor {
  id?: string
  email?: string
  type?: string
}

/** A single Cloudflare audit-log entry (only the fields we read). */
export interface CloudflareAuditEvent {
  actor?: AuditActor
  when?: string
  action?: { type?: string; result?: boolean | string }
  resource?: { id?: string; type?: string }
}

export interface ResolveDriftActorOptions {
  /** Live Cloudflare object id — matched against the audit entry `resource.id`. */
  targetId?: string
  /** Object name / setting key — matched against `resource.id` as a fallback. */
  targetName?: string
  /** ISO lower bound for the log window; defaults to ~7 days ago. */
  since?: string
  /** Connection login(s) to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the audit query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** The list is DESCENDING, so a small page is enough to find the last human change. */
const AUDIT_PER_PAGE = 50

/**
 * Substrings of an `action.type` that represent a user-driven CHANGE. `pickActor`
 * prefers these; if none match it falls back to the most recent human,
 * non-Veltrix event so attribution stays best-effort. Cloudflare action types are
 * lower-case verbs (e.g. "create", "update", "delete", "add", "disable").
 */
const CHANGE_ACTION_KEYWORDS = [
  'create',
  'update',
  'delete',
  'add',
  'remove',
  'edit',
  'patch',
  'modify',
  'change',
  'set',
  'put',
  'post',
  'enable',
  'disable',
]

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** True when the event's actor is a human dashboard user (has an email + type "user"). */
function isHumanActor(event: CloudflareAuditEvent): boolean {
  const email = typeof event.actor?.email === 'string' ? event.actor.email.trim() : ''
  return normalizeLogin(event.actor?.type) === 'user' && email !== ''
}

/** True when the event's actor is one of the excluded (Veltrix) logins. */
function isExcludedActor(event: CloudflareAuditEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const email = normalizeLogin(event.actor?.email)
  const id = normalizeLogin(event.actor?.id)
  return (email !== '' && excluded.has(email)) || (id !== '' && excluded.has(id))
}

/** True when the action type looks like a change to a managed object. */
function isChangeEvent(actionType: string | undefined): boolean {
  const t = normalizeLogin(actionType)
  if (t === '') return false
  return CHANGE_ACTION_KEYWORDS.some((keyword) => t.includes(keyword))
}

/** True when an audit entry refers to the drifted object (by live id or name). */
function eventMatchesTarget(
  event: CloudflareAuditEvent,
  targetId: string | undefined,
  targetName: string | undefined,
): boolean {
  const rid = typeof event.resource?.id === 'string' ? event.resource.id.trim() : ''
  if (rid === '') return false
  if (targetId && rid === targetId) return true
  if (targetName && rid === targetName) return true
  return false
}

/** Map a chosen audit entry to the DriftActor shape (only defined fields kept). */
function toActor(event: CloudflareAuditEvent): DriftActor {
  const actor: DriftActor = { source: 'cloudflare-audit' }
  const id = typeof event.actor?.id === 'string' ? event.actor.id.trim() : ''
  const email = typeof event.actor?.email === 'string' ? event.actor.email.trim() : ''
  if (id) actor.id = id
  if (email) {
    // The audit log identifies a human by email only — use it for both fields.
    actor.name = email
    actor.email = email
  }
  if (event.when) actor.at = event.when
  if (event.action?.type) actor.eventType = event.action.type
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live audit call. Considers only human (`actor.type ===
 * 'user'` with an email), non-excluded events, and sorts by `when` DESCENDING so
 * it is order-independent. Prefers a change-type action; if none match, falls
 * back to the most recent human, non-excluded event. Returns undefined when
 * nothing usable remains. Callers pass events ALREADY correlated to the target.
 */
export function pickActorFromEvents(
  events: CloudflareAuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns DESCENDING, but sort defensively.
    .sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event.action?.type))
  return toActor(preferred ?? candidates[0])
}

/**
 * Resolve WHO last manually changed a drifted Cloudflare object and WHEN, from
 * the account audit logs. Fetches one page of recent entries (since ~7d,
 * DESCENDING), correlates them to the target by `resource.id`, and picks the
 * last human non-Veltrix change. Best-effort: returns undefined when neither a
 * target id nor name is given, on any error, a non-OK response (e.g. the token
 * lacks Audit Logs read scope), an empty log, or no usable human event —
 * attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: CloudflareClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    if (!opts.targetId && !opts.targetName) return undefined

    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const res = await client.account('GET', '/audit_logs', {
      query: { since, per_page: AUDIT_PER_PAGE, direction: 'desc' },
    })
    if (!res.ok) return undefined

    const env = parseJson<CloudflareEnvelope<CloudflareAuditEvent[]>>(res.body)
    const events = env?.result
    if (!Array.isArray(events)) return undefined

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
  client: CloudflareClient,
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
 * identity our own changes appear under in the audit log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
