// =============================================================================
// Splunk Enterprise audit — drift attribution ("who changed it + when").
//
// When a config type detects that a live Splunk object (an app, an HEC token)
// has drifted from its deployed state, this resolves WHO made the last manual
// change and WHEN by querying Splunk's internal `_audit` index. The result is
// attached to each drift diff as an optional `actor`, which the platform stores
// as-is and the client renders.
//
// The audit query is a BLOCKING search export (POST .../jobs/export) so results
// come back in ONE request — no async search job to create, poll and reap.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error, an empty result, or no usable human
// event, it returns undefined and the diff is reported without an actor (the UI
// shows "—").
//
// Veltrix's own deploys run through the connection's service account, so they
// appear in the audit log as that user. To attribute the MANUAL change (not our
// own deploy), the caller passes the connection's login(s) in `excludeActorLogins`
// and those events are skipped, alongside Splunk's internal principals.
// =============================================================================

import { buildAuthHeader, buildSplunkUrl, splunkFetch } from '../../lib/splunkApi'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** Attribution attached to a drifted diff — mirrors the SDK's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/**
 * One normalized `_audit` row (only the fields we read). Maps from Splunk's
 * `| table _time user action object` result columns.
 */
export interface AuditEvent {
  /** The acting principal's login. */
  user?: string
  /** The audit action, e.g. `edit`, `create`, `delete`, `search`. */
  action?: string
  /** The event time (`_time`), kept as the string Splunk returns. */
  time?: string
  /** The affected object's name (the drifted item's identity). */
  object?: string
}

export interface ResolveDriftActorOptions {
  /** The drifted object's NAME — Splunk audit keys on object name, not an id. */
  objectName?: string
  /** Splunk relative/absolute lower bound for the audit window; defaults to -7d. */
  earliest?: string
  /** Connection login(s) to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
}

/** Default look-back window for the audit search. */
const DEFAULT_EARLIEST = '-7d'
/** A short page is enough to find the last human change (results are recent-first). */
const SEARCH_LIMIT = 20
/** Attribution is best-effort — keep the audit search on a short leash. */
const AUDIT_TIMEOUT_MS = 8_000

/**
 * Blocking search export endpoints, newest first. splunkd 8.1+ serves the v2
 * path; older releases only have v1, so we fall back to it on a 404.
 */
const AUDIT_EXPORT_PATHS = ['/services/search/v2/jobs/export', '/services/search/jobs/export']

/**
 * Splunk's own principals — never a human manual change. The connection's own
 * username is excluded separately (see veltrixActorLogins) so an `admin` service
 * account is covered by the connection login too.
 */
const SYSTEM_LOGINS = new Set(['splunk-system-user', 'n/a', '-', ''])

/**
 * Substrings of an `action` that indicate a user-driven CHANGE (as opposed to a
 * read such as `search` / `list` / `login`). `pickActorFromEvents` prefers these;
 * if none match it falls back to the most recent human event so attribution is
 * still best-effort.
 */
const CHANGE_ACTION_KEYWORDS = [
  'edit',
  'create',
  'delete',
  'update',
  'add',
  'remove',
  'enable',
  'disable',
  'save',
  'reload',
  'move',
]

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** True when the event's user is a real human (not a Splunk internal principal). */
function isHumanActor(event: AuditEvent): boolean {
  const user = normalizeLogin(event.user)
  return user !== '' && !SYSTEM_LOGINS.has(user)
}

/** True when the event's user is one of the excluded (Veltrix) logins. */
function isExcludedActor(event: AuditEvent, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const user = normalizeLogin(event.user)
  return user !== '' && excluded.has(user)
}

/** True when the action looks like a change to a managed object. */
function isChangeEvent(action: string | undefined): boolean {
  const a = (action ?? '').toLowerCase()
  if (a === '') return false
  return CHANGE_ACTION_KEYWORDS.some((keyword) => a.includes(keyword))
}

/** Map a chosen audit row to the DriftActor shape (only defined fields kept). */
function toActor(event: AuditEvent): DriftActor {
  const actor: DriftActor = { source: 'splunk-audit' }
  if (event.user) actor.name = event.user
  if (event.time) actor.at = event.time
  if (event.action) actor.eventType = event.action
  return actor
}

/**
 * Pick the actor of the most relevant audit event — PURE, so it is unit-testable
 * in isolation from the live search. Considers only human, non-excluded events
 * and (defensively) sorts by `time` DESCENDING so it is order-independent.
 * Prefers a change-type action; if none match, falls back to the most recent
 * human, non-excluded event. Returns undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  events: AuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isHumanActor(event) && !isExcludedActor(event, excluded))
    // Most recent first — `_time` sorts lexicographically for ISO timestamps.
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeEvent(event.action))
  return toActor(preferred ?? candidates[0])
}

/** A minimal client for the blocking `_audit` search export — trivially mockable. */
export interface SplunkAuditClient {
  /**
   * POST a blocking oneshot search export and return the raw response text.
   * NEVER throws — a network/HTTP failure resolves to `{ ok: false, body: '' }`.
   */
  searchExport(search: string, params: Record<string, string>): Promise<{ ok: boolean; body: string }>
}

/**
 * Build the audit client from a component + connectivity + credential, reusing
 * the SAME base-URL / auth / fetch mechanism as every other Splunk handler
 * (buildSplunkUrl + buildAuthHeader + fetch with an AbortSignal timeout).
 */
export function buildSplunkAuditClient(
  component: ComponentRef,
  connectivity: ConnectivityRef,
  credential: CredentialRef,
): SplunkAuditClient {
  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)
  return auditClientFromBase(baseUrl, auth)
}

/**
 * Lower-level factory when the caller already resolved the base URL + auth
 * headers (the drift handlers do). Kept separate so the network mechanism has a
 * single definition.
 */
export function auditClientFromBase(
  baseUrl: string,
  auth: Record<string, string>,
): SplunkAuditClient {
  return {
    async searchExport(search, params) {
      const form = new URLSearchParams({ search, ...params })
      for (const path of AUDIT_EXPORT_PATHS) {
        try {
          const res = await splunkFetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            timeoutMs: AUDIT_TIMEOUT_MS,
          })
          if (res.ok) return { ok: true, body: await res.text() }
          // Only an older splunkd (no v2 export) warrants trying the next path.
          if (res.status === 404) continue
          return { ok: false, body: '' }
        } catch {
          // Try the fallback path; if that also throws we return not-ok below.
        }
      }
      return { ok: false, body: '' }
    },
  }
}

/** Escape a value for interpolation inside an SPL double-quoted string. */
function escapeSpl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the `_audit` SPL for a single drifted object. Keyed on the object NAME
 * because Splunk's audit log records `object="<name>"`, not an id.
 */
export function buildAuditSearch(objectName: string): string {
  return `search index=_audit action=* object="${escapeSpl(objectName)}" | head ${SEARCH_LIMIT} | table _time user action object`
}

/**
 * Parse a search-export response body. The export endpoint streams newline-
 * delimited JSON, one object per line; result rows carry a `result` field. We
 * tolerate blank lines, preview/message lines, and malformed lines.
 */
export function parseAuditResults(body: string): AuditEvent[] {
  if (typeof body !== 'string' || body.trim() === '') return []
  const events: AuditEvent[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const row = (parsed as { result?: unknown }).result
    const result = row && typeof row === 'object' ? (row as Record<string, unknown>) : null
    if (!result) continue
    const event: AuditEvent = {}
    if (typeof result.user === 'string') event.user = result.user
    if (typeof result.action === 'string') event.action = result.action
    if (typeof result._time === 'string') event.time = result._time
    if (typeof result.object === 'string') event.object = result.object
    events.push(event)
  }
  return events
}

/**
 * Resolve WHO last manually changed a drifted Splunk object and WHEN, from the
 * `_audit` index. Best-effort: returns undefined on any error, an empty result,
 * or no usable human event — attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: SplunkAuditClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const name = opts.objectName?.trim()
    if (!name) return undefined

    const res = await client.searchExport(buildAuditSearch(name), {
      output_mode: 'json',
      earliest_time: opts.earliest ?? DEFAULT_EARLIEST,
    })
    if (!res.ok) return undefined

    const events = parseAuditResults(res.body)
    return pickActorFromEvents(events, opts.excludeActorLogins ?? [])
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
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set STRUCTURALLY.
 */
export async function attachDriftActor(
  client: SplunkAuditClient,
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
 * identity our own changes appear under in the `_audit` log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
