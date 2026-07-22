// =============================================================================
// Intune audit log — drift attribution ("who changed it + when").
//
// When a config type detects that a live Intune policy has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the Microsoft Graph Intune audit events API
// (GET /deviceManagement/auditEvents). The result is attached to each drifted
// diff as an optional `actor`, which the platform stores as-is and the client
// renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty log, or no usable human
// event, it returns undefined and the diff is reported without an actor (the UI
// shows "—").
//
// Veltrix deploys run app-only (OAuth2 client credentials), so their audit
// events carry an APPLICATION actor with no `userPrincipalName` — they are
// already dropped by the human-only filter. As a second guard, the connection's
// Client ID (app registration appId) is passed in `excludeActorLogins` and any
// event whose actor application id / display name matches is skipped, so
// attribution reflects the MANUAL change, not our own deploy.
//
// NOTE ON TYPES: microsoft-intune typechecks against an SDK build whose
// `DriftDiff` has no `actor` field, so this module declares its OWN `DriftActor`
// (it never imports one from the SDK) and sets the field STRUCTURALLY on an
// `object[]`, adding zero new tsc errors.
// =============================================================================

import { parseJson, type IntuneClient, type ODataEnvelope } from './intune'

/** Attribution attached to a drifted diff (a local shape — see the type note above). */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** An Intune audit-event actor (only the fields we read). */
interface AuditActor {
  userPrincipalName?: string | null
  userId?: string | null
  applicationId?: string | null
  applicationDisplayName?: string | null
  servicePrincipalName?: string | null
}

/** An entry in an audit event's `resources[]` (only the fields we read). */
interface AuditResource {
  resourceId?: string | null
  displayName?: string | null
}

/** A single Intune audit event (deviceManagement/auditEvents) — fields we read. */
export interface IntuneAuditEvent {
  actor?: AuditActor
  activityDateTime?: string
  activityType?: string
  activityOperationType?: string
  displayName?: string
  resources?: AuditResource[]
}

export interface ResolveDriftActorOptions {
  /** Managed policy's Graph id — the reliable resource correlation. */
  targetId?: string
  /** Policy name — a best-effort fallback (e.g. a deleted policy with no live id). */
  targetName?: string
  /** ISO lower bound for the audit window; defaults to ~7 days ago. */
  since?: string
  /** Veltrix app identity (Client ID / appId) to skip — our own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the audit query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** Page size for the targeted (resource-correlated) query. */
const TARGETED_TOP = 20
/** Page size for the broad time-window fallback (correlated client-side). */
const BROAD_TOP = 100

/**
 * activityOperationType / activityType hints that represent a user-driven CHANGE
 * (not a read). Intune only logs writes, but preferring an explicit change verb
 * keeps attribution on the mutation rather than an incidental event.
 */
const CHANGE_OPERATION_HINTS = ['create', 'patch', 'update', 'delete', 'set', 'remove', 'assign', 'write']

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** True when the actor is a human user — it carries a `userPrincipalName`. */
function isHumanActor(event: IntuneAuditEvent): boolean {
  return normalize(event.actor?.userPrincipalName) !== ''
}

/** True when the actor is one of the excluded (Veltrix app/service) identities. */
function isExcludedActor(event: IntuneAuditEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const a = event.actor
  const candidates = [a?.applicationId, a?.applicationDisplayName, a?.servicePrincipalName, a?.userPrincipalName, a?.userId]
  return candidates.some((value) => {
    const n = normalize(value)
    return n !== '' && excluded.has(n)
  })
}

/** True when the event's operation/type looks like a change to a managed object. */
function isChangeEvent(event: IntuneAuditEvent): boolean {
  const haystack = `${normalize(event.activityOperationType)} ${normalize(event.activityType)} ${normalize(event.displayName)}`
  return CHANGE_OPERATION_HINTS.some((hint) => haystack.includes(hint))
}

/** Map a chosen audit event to the DriftActor shape (only defined fields kept). */
function toActor(event: IntuneAuditEvent): DriftActor {
  const actor: DriftActor = { source: 'intune-audit' }
  const a = event.actor
  if (a?.userId) actor.id = a.userId
  if (a?.userPrincipalName) {
    actor.name = a.userPrincipalName
    actor.email = a.userPrincipalName
  } else if (a?.applicationDisplayName) {
    actor.name = a.applicationDisplayName
  }
  if (event.activityDateTime) actor.at = event.activityDateTime
  const eventType = event.activityType || event.displayName || event.activityOperationType
  if (eventType) actor.eventType = eventType
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from the live audit call. Considers only human (a `userPrincipalName`
 * is present), non-excluded events, and (defensively) sorts by `activityDateTime`
 * DESCENDING so it is order-independent. Prefers a change-type event; if none
 * match, falls back to the most recent human, non-excluded event. Returns
 * undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  events: IntuneAuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalize).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — the API returns DESCENDING, but sort defensively.
    .sort((a, b) => (b.activityDateTime ?? '').localeCompare(a.activityDateTime ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event))
  return toActor(preferred ?? candidates[0])
}

/** Escape a value for an OData string literal (single quotes are doubled). */
function escapeOData(value: string): string {
  return value.replace(/'/g, "''")
}

/** True when an event's `resources[]` references the target object (id or name). */
function eventMatchesResource(event: IntuneAuditEvent, id?: string, name?: string): boolean {
  const resources = Array.isArray(event.resources) ? event.resources : []
  const wantId = normalize(id)
  const wantName = normalize(name)
  return resources.some((r) => {
    if (wantId && normalize(r.resourceId) === wantId) return true
    if (wantName && normalize(r.displayName) === wantName) return true
    return false
  })
}

/** GET one page of audit events for a filter. Returns null on any non-OK/parse failure. */
async function fetchAuditEvents(
  client: IntuneClient,
  filter: string,
  top: number,
): Promise<IntuneAuditEvent[] | null> {
  const res = await client.request('GET', '/deviceManagement/auditEvents', {
    query: { $filter: filter, $orderby: 'activityDateTime desc', $top: top },
  })
  if (!res.ok) return null
  const env = parseJson<ODataEnvelope<IntuneAuditEvent>>(res.body)
  return Array.isArray(env?.value) ? env!.value! : null
}

/**
 * Resolve WHO last manually changed a drifted Intune policy and WHEN, from the
 * Intune audit events. Two passes, both correlated to the target CLIENT-SIDE so
 * an unrelated object's change is never attributed:
 *   1. a TARGETED query that also correlates server-side
 *      (`resources/any(r:r/resourceId eq "…")`, or displayName as a fallback);
 *   2. if that yields nothing usable (or the tenant rejects the resource filter),
 *      a BROAD time-window query correlated locally.
 * Best-effort: returns undefined on any error, an empty log, or no usable human
 * event — attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: IntuneClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const timeClause = `activityDateTime ge ${since}`

    let resourceClause: string | null = null
    if (opts.targetId) {
      resourceClause = `resources/any(r:r/resourceId eq '${escapeOData(opts.targetId)}')`
    } else if (opts.targetName) {
      resourceClause = `resources/any(r:r/displayName eq '${escapeOData(opts.targetName)}')`
    } else {
      return undefined
    }

    const pickCorrelated = (events: IntuneAuditEvent[] | null): DriftActor | undefined =>
      events
        ? pickActorFromEvents(
            events.filter((event) => eventMatchesResource(event, opts.targetId, opts.targetName)),
            opts.excludeActorLogins ?? [],
          )
        : undefined

    // 1) Targeted server-side correlation (unsupported on some tenants → null → fallback).
    const targeted = await fetchAuditEvents(client, `${timeClause} and ${resourceClause}`, TARGETED_TOP)
    const actor = pickCorrelated(targeted)
    if (actor) return actor

    // 2) Broad time-window fallback, always supported, correlated client-side.
    const broad = await fetchAuditEvents(client, timeClause, BROAD_TOP)
    return pickCorrelated(broad)
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
 * cast at the call site even though the SDK build's `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: IntuneClient,
  diffs: object[],
  opts: ResolveDriftActorOptions,
): Promise<void> {
  if (!diffs || diffs.length === 0) return
  const actor = await resolveDriftActor(client, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The Veltrix identity to exclude from attribution. Intune deploys authenticate
 * as the app registration (OAuth2 client credentials), so the credential's
 * `username` — the Client ID / appId — is the identity our own changes appear
 * under (`actor.applicationId`) in the audit log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const clientId = credential?.username?.trim()
  return clientId ? [clientId] : []
}
