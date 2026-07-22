// =============================================================================
// Wiz Audit Log — drift attribution ("who changed it + when").
//
// When a config type detects that a live Wiz object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the Wiz GraphQL `auditLogEntries` API. The result is attached to each
// DriftDiff as an optional `actor`, which the platform stores as-is and the
// client renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty log, or no usable human
// event, it returns undefined and the diff is reported without an actor.
//
// Wiz's audit log has no per-object subject field, so correlation to the drifted
// object is done client-side: an entry is considered to concern a target when
// the target's id (preferred) or name appears in the entry's `actionParameters`
// (the recorded mutation input) or `action`.
//
// Veltrix's own deploys authenticate as a Wiz service account, so a change WE
// made is recorded under that service account (with no `user`) — already skipped
// because attribution only considers human (`user`-bearing) entries. The caller
// still passes the connection's client id in `excludeActorLogins` so any entry
// naming that identity (service account OR user) is defensively excluded.
// =============================================================================

import type { WizClient } from '../../lib/wiz'

/** Attribution attached to a drifted diff. LOCAL — the SDK's DriftDiff has no `actor`. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** An audit-log principal (the fields we read). */
export interface WizAuditPrincipal {
  id?: string
  name?: string
  email?: string
}

/** A single `auditLogEntries` node (only the fields we read). */
export interface WizAuditEvent {
  id?: string
  action?: string
  status?: string
  timestamp?: string
  /** The recorded mutation input — a JSON value used only for target correlation. */
  actionParameters?: unknown
  /** Present when a human user initiated the action. */
  user?: WizAuditPrincipal | null
  /** Present when a service account (e.g. Veltrix's own deploy) initiated the action. */
  serviceAccount?: WizAuditPrincipal | null
}

export interface ResolveDriftActorOptions {
  /** Wiz object id — the most reliable correlation key against actionParameters. */
  targetId?: string
  /** Object name — a best-effort correlation fallback when the id is unknown. */
  targetName?: string
  /** ISO lower bound for the log window; defaults to ~7 days ago. */
  since?: string
  /** Connection identity(ies) to skip — Veltrix's own deploy (the API client id). */
  excludeActorLogins?: string[]
}

/** Default look-back window for the log query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** Entries are read most-recent-first, so a small page finds the last human change. */
const AUDIT_LIMIT = 50

/**
 * The `auditLogEntries` query — verified against the Wiz schema (there is no
 * `subjectResource`; `actionParameters` carries the mutation input we correlate
 * against). `filterBy.timestamp.after` bounds the window server-side.
 */
export const AUDIT_LOG_QUERY = `
query DriftAuditLog($first: Int, $filterBy: AuditLogEntryFilters) {
  auditLogEntries(first: $first, filterBy: $filterBy) {
    nodes {
      id
      action
      status
      timestamp
      actionParameters
      user { id name email }
      serviceAccount { id name }
    }
  }
}`

interface WizAuditLogResponse {
  auditLogEntries?: { nodes?: WizAuditEvent[] } | null
}

/**
 * Action-name prefixes that represent a user-driven CHANGE to a managed object.
 * `pickActorFromEvents` prefers these; if none match it falls back to the most
 * recent human, non-Veltrix event so attribution is still best-effort.
 */
const CHANGE_ACTION_PREFIXES = [
  'create',
  'update',
  'delete',
  'rotate',
  'modify',
  'patch',
  'replace',
  'set',
  'enable',
  'disable',
  'add',
  'remove',
  'assign',
  'unassign',
]

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** Serialize a principal's identifiers to a normalized lookup set. */
function principalIdentifiers(principal: WizAuditPrincipal | null | undefined): string[] {
  if (!principal) return []
  return [principal.id, principal.name, principal.email].map(normalizeLogin).filter((v) => v !== '')
}

/** True when a human user initiated the event (not a service account). */
function isHumanActor(event: WizAuditEvent): boolean {
  const user = event.user
  return !!user && (!!user.id || !!user.name || !!user.email)
}

/** True when the event's actor (user OR service account) is an excluded (Veltrix) identity. */
function isExcludedActor(event: WizAuditEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const identities = [...principalIdentifiers(event.user), ...principalIdentifiers(event.serviceAccount)]
  return identities.some((id) => excluded.has(id))
}

/** True when the action name looks like a change to a managed object. */
function isChangeEvent(action: string | undefined): boolean {
  const a = (action ?? '').trim().toLowerCase()
  return CHANGE_ACTION_PREFIXES.some((prefix) => a.startsWith(prefix))
}

/** Serialize actionParameters + action into a single lowercased haystack for correlation. */
function correlationHaystack(event: WizAuditEvent): string {
  let params = ''
  try {
    params =
      typeof event.actionParameters === 'string'
        ? event.actionParameters
        : event.actionParameters == null
          ? ''
          : JSON.stringify(event.actionParameters)
  } catch {
    params = ''
  }
  return `${params}\n${event.action ?? ''}`.toLowerCase()
}

/**
 * True when an audit entry concerns the drifted object — PURE, so it is
 * unit-testable. Wiz has no subject-resource field, so correlation matches the
 * target's id (preferred) or name inside the entry's actionParameters/action.
 * Returns false when no target key is supplied (nothing to correlate against).
 */
export function eventMatchesTarget(
  event: WizAuditEvent,
  target: { targetId?: string; targetName?: string },
): boolean {
  const id = (target.targetId ?? '').trim().toLowerCase()
  const name = (target.targetName ?? '').trim().toLowerCase()
  if (id === '' && name === '') return false
  const hay = correlationHaystack(event)
  if (id !== '' && hay.includes(id)) return true
  if (name !== '' && hay.includes(name)) return true
  return false
}

/** Map a chosen audit event to the DriftActor shape (only defined fields kept). */
function toActor(event: WizAuditEvent): DriftActor {
  const actor: DriftActor = { source: 'wiz-audit' }
  const user = event.user
  if (user?.id) actor.id = user.id
  if (user?.name) actor.name = user.name
  if (user?.email) actor.email = user.email
  if (event.timestamp) actor.at = event.timestamp
  if (event.action) actor.eventType = event.action
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live audit-log call. Considers only human (`user`-bearing),
 * non-excluded events and sorts by `timestamp` DESCENDING so it is
 * order-independent. Prefers a change-type action; if none match, falls back to
 * the most recent human, non-excluded event. Returns undefined when nothing
 * usable remains.
 */
export function pickActorFromEvents(
  events: WizAuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns newest-first, but sort defensively.
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event.action))
  return toActor(preferred ?? candidates[0])
}

/**
 * Resolve WHO last manually changed a drifted Wiz object and WHEN, from the audit
 * log. Fetches a recent page of `auditLogEntries`, correlates them to the target
 * by id/name (Wiz has no subject-resource field), then picks the last human,
 * non-Veltrix change. Best-effort: returns undefined on any error, an empty log,
 * no correlated entry, or no usable human event — attribution never throws or
 * fails a drift check.
 */
export async function resolveDriftActor(
  client: WizClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    if (!opts.targetId && !opts.targetName) return undefined

    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const res = await client.graphql<WizAuditLogResponse>(AUDIT_LOG_QUERY, {
      first: AUDIT_LIMIT,
      filterBy: { timestamp: { after: since } },
    })
    if (res.transportError || res.errors) return undefined

    const nodes = res.data?.auditLogEntries?.nodes
    if (!Array.isArray(nodes)) return undefined

    const correlated = nodes.filter((event) =>
      eventMatchesTarget(event, { targetId: opts.targetId, targetName: opts.targetName }),
    )
    return pickActorFromEvents(correlated, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so both driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even though the SDK's `DriftDiff` has no `actor` field;
 * the field is set structurally.
 */
export async function attachDriftActor(
  client: WizClient,
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
 * The credential's username is the Wiz service-account Client ID our deploys
 * authenticate with, so it is the identity our own changes are recorded under.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
