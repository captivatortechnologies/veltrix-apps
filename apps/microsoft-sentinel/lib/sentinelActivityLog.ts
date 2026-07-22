// =============================================================================
// Sentinel drift attribution ("who changed it + when") via the Azure Activity Log.
//
// Microsoft Sentinel objects are Azure Resource Manager (ARM) resources, so the
// audit trail for manual changes is the subscription's Azure Activity Log
// (management events), NOT Microsoft Graph. When a config type detects that a
// live Sentinel resource has drifted from its deployed state, this resolves WHO
// made the last manual change and WHEN by querying
//   GET /subscriptions/{sub}/providers/Microsoft.Insights/eventtypes/management/values
//        ?api-version=2015-04-01
//        &$filter=eventTimestamp ge '<iso-7d>' and resourceUri eq '<resourceId>'
// and correlating the returned records to the drifted resource by resourceId.
// The result is attached to each drifted diff as an optional `actor`, which the
// platform stores as-is and the client renders.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty log, or no usable human
// event, it returns undefined and the diff is reported without an actor (the UI
// shows "—"). Reading the Activity Log requires Microsoft.Insights/eventtypes/
// values/read at the subscription; a service principal scoped only to the
// workspace resource group may be denied — that just degrades to "—".
//
// Veltrix deploys authenticate as the Entra app registration (OAuth2 client
// credentials), so their Activity-Log records carry the app's appId (a bare
// GUID) as `caller` — already dropped by the human-only filter (a human caller
// is a UPN/email, not a GUID). As a second guard the connection's Client ID is
// passed in `excludeActorLogins` and any record whose caller / appid claim
// matches is skipped, so attribution reflects the MANUAL change, not our deploy.
//
// NOTE ON TYPES: microsoft-sentinel typechecks against an SDK build whose
// `DriftDiff` has no `actor` field, so this module declares its OWN `DriftActor`
// (it never imports one from the SDK) and sets the field STRUCTURALLY on an
// `object[]`, adding zero new tsc errors.
// =============================================================================

import { parseJson, type ArmCollection, type SentinelClient } from './sentinel'

/** Attribution attached to a drifted diff (a local shape — see the type note above). */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** A single Azure Activity Log management record (only the fields we read). */
export interface ActivityLogRecord {
  /** The identity that performed the operation: a UPN (human) or an appId/GUID (service principal). */
  caller?: string | null
  eventTimestamp?: string | null
  operationName?: { value?: string | null; localizedValue?: string | null } | null
  /** Full ARM resource id the operation targeted — the correlation key. */
  resourceId?: string | null
  /** Token claims (e.g. `appid`, objectidentifier) captured with the record. */
  claims?: Record<string, string> | null
  status?: { value?: string | null; localizedValue?: string | null } | null
}

export interface ResolveDriftActorOptions {
  /** Full ARM resource id of the drifted object — correlated against each record. */
  resourceId?: string
  /** ISO lower bound for the Activity Log window; defaults to ~7 days ago. */
  since?: string
  /** Veltrix app identity (Client ID / appId) to skip — our own deploy events. */
  excludeActorLogins?: string[]
}

/** Only the client surface this module depends on (keeps mocks small and typed). */
type ActivityLogClient = Pick<SentinelClient, 'request' | 'subscriptionPath'>

/** Default look-back window for the Activity Log query (~7 days). */
const DEFAULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** The Azure Activity Log (Microsoft.Insights) query api-version. */
export const ACTIVITY_LOG_API_VERSION = '2015-04-01'

/** operationName substrings that represent a user-driven CHANGE (a mutation, not a read). */
const CHANGE_OPERATION_HINTS = ['/write', '/delete', '/action']

/** Token-claim keys we read for a human actor's object id / app id. */
const OBJECT_ID_CLAIM = 'http://schemas.microsoft.com/identity/claims/objectidentifier'
const APP_ID_CLAIM = 'appid'

/** A bare GUID — a service-principal appId / object id, never a human UPN. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A UPN / email shape — the marker of a human caller in the Activity Log. */
const UPN_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/**
 * True when the record's `caller` is a human — a UPN/email rather than a bare
 * appId/GUID service principal. Sentinel writes by an app-only client credential
 * appear with a GUID caller and are therefore excluded here.
 */
function isHumanCaller(caller: string | null | undefined): boolean {
  const c = normalize(caller)
  if (!c || GUID_RE.test(c)) return false
  return UPN_RE.test(c)
}

/** True when the record's caller / appid claim is one of the excluded (Veltrix) identities. */
function isExcludedActor(record: ActivityLogRecord, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const candidates = [record.caller, record.claims?.[APP_ID_CLAIM], record.claims?.[OBJECT_ID_CLAIM]]
  return candidates.some((value) => {
    const n = normalize(value)
    return n !== '' && excluded.has(n)
  })
}

/** True when the record's operation looks like a change to the resource (write/delete/action). */
function isChangeEvent(record: ActivityLogRecord): boolean {
  const op = normalize(record.operationName?.value ?? record.operationName?.localizedValue)
  return CHANGE_OPERATION_HINTS.some((hint) => op.includes(hint))
}

/** Map a chosen Activity Log record to the DriftActor shape (only defined fields kept). */
function toActor(record: ActivityLogRecord): DriftActor {
  const actor: DriftActor = { source: 'sentinel-audit' }
  const caller = typeof record.caller === 'string' ? record.caller.trim() : ''
  if (caller) {
    actor.name = caller
    actor.email = caller
  }
  const objectId = record.claims?.[OBJECT_ID_CLAIM]
  if (objectId && objectId.trim()) actor.id = objectId.trim()
  if (record.eventTimestamp) actor.at = record.eventTimestamp
  const eventType = record.operationName?.value || record.operationName?.localizedValue
  if (eventType) actor.eventType = eventType
  return actor
}

/**
 * Pick the actor of the most relevant record — PURE, so it is unit-testable in
 * isolation from the live Activity Log call. Considers only human (`caller` is a
 * UPN/email), non-excluded records, and (defensively) sorts by `eventTimestamp`
 * DESCENDING so it is order-independent. Prefers a change-type operation
 * (write/delete/action); if none match, falls back to the most recent human,
 * non-excluded record. Returns undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  events: ActivityLogRecord[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalize).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanCaller(event.caller) && !isExcludedActor(event, excluded))
    // Most recent first — the API is not guaranteed to sort, so sort defensively.
    .sort((a, b) => (b.eventTimestamp ?? '').localeCompare(a.eventTimestamp ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event))
  return toActor(preferred ?? candidates[0])
}

/** True when a record targets the drifted resource (case-insensitive resourceId match). */
function matchesResource(record: ActivityLogRecord, resourceId: string): boolean {
  return normalize(record.resourceId) === normalize(resourceId)
}

/**
 * Resolve WHO last manually changed a drifted Sentinel resource and WHEN, from
 * the subscription's Azure Activity Log. A single targeted management-events
 * query filtered by `resourceUri eq '<resourceId>'` over the look-back window,
 * with the returned records ALSO correlated to the target client-side so an
 * unrelated resource's change is never attributed. Best-effort: returns
 * undefined on any error, an empty log, or no usable human record — attribution
 * never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: ActivityLogClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    if (!opts.resourceId) return undefined
    const subscriptionPath = client.subscriptionPath()
    if (!subscriptionPath) return undefined

    const since = opts.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString()
    const filter = `eventTimestamp ge '${since}' and resourceUri eq '${opts.resourceId}'`

    const res = await client.request('GET', `${subscriptionPath}/providers/Microsoft.Insights/eventtypes/management/values`, {
      apiVersion: ACTIVITY_LOG_API_VERSION,
      query: { $filter: filter },
    })
    if (!res.ok) return undefined

    const env = parseJson<ArmCollection<ActivityLogRecord>>(res.body)
    const records = Array.isArray(env?.value) ? env!.value! : []
    const correlated = records.filter((record) => matchesResource(record, opts.resourceId!))

    return pickActorFromEvents(correlated, opts.excludeActorLogins ?? [])
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
 * cast at the call site even though the SDK build's `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export async function attachDriftActor(
  client: ActivityLogClient,
  diffs: object[],
  opts: ResolveDriftActorOptions,
): Promise<void> {
  if (!diffs || diffs.length === 0) return
  const actor = await resolveDriftActor(client, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The Veltrix identity to exclude from attribution. Sentinel deploys authenticate
 * as the Entra app registration (OAuth2 client credentials), so the credential's
 * `username` — the Client ID / appId — is the identity our own changes appear
 * under (`caller` / `appid` claim) in the Activity Log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const clientId = credential?.username?.trim()
  return clientId ? [clientId] : []
}
