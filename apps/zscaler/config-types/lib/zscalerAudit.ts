// =============================================================================
// Zscaler (ZIA + ZPA) — drift attribution ("who changed it + when").
//
// When a config type detects that a live Zscaler object has drifted from its
// deployed state, this resolves WHO made the last change and WHEN. Zscaler
// records the modifier DIRECTLY on every managed resource, so — unlike a
// separate audit-log lookup — attribution reads the fields the drift check
// ALREADY fetched (no extra API call, no async report flow, no added scope):
//   - ZIA objects (rules, groups, dictionaries, users, …): `lastModifiedBy`
//     (an id/name pair — `{ id, name }`) + `lastModifiedTime` (epoch seconds).
//   - ZPA objects (segments, groups, servers, …):           `modifiedBy` (the
//     admin's id) + `modifiedTime` (epoch seconds, as a string).
// These fields are not declared on the app's `Live*` types and are not parsed
// anywhere else — they simply ride along on the JSON the list endpoints return,
// so the drifted resource already carries them. When an endpoint omits them the
// resource is left unattributed (the UI shows "—"); attribution never guesses.
//
// STRICTLY BEST-EFFORT: every entry point returns undefined rather than
// throwing, so attribution can NEVER break a drift check.
//
// Veltrix's own deploys run through the connection's OneAPI client, so a change
// WE made is recorded under that client's identity. To attribute the MANUAL
// change (not our own deploy), the caller passes the client id in
// `excludeActorLogins` and a resource last written by us is left unattributed.
//
// TYPE SAFETY: the SDK's `DriftDiff` has no `actor` field, so this defines a
// LOCAL `DriftActor` (no SDK import), takes `diffs` as `object[]`, and sets the
// actor STRUCTURALLY — the wiring compiles on an SDK build whose `DriftDiff`
// predates the optional `actor` field.
// =============================================================================

/** Attribution attached to a drifted diff — mirrors the platform's optional DriftActor. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/**
 * The modifier fields this reads off a live Zscaler resource. ZIA objects use
 * `lastModifiedBy` (an id/name pair) + `lastModifiedTime`; ZPA objects use
 * `modifiedBy` (a bare id) + `modifiedTime` — both shapes are read so one
 * extractor serves every ZIA and ZPA config type.
 */
export interface ZscalerModifiedResource {
  // ZIA shape.
  lastModifiedBy?: { id?: number | string | null; name?: string | null } | null
  lastModifiedTime?: number | string | null
  // ZPA shape.
  modifiedBy?: number | string | null
  modifiedTime?: number | string | null
}

export interface ResolveDriftActorOptions {
  /** Connection identity(ies) to skip — Veltrix's own deploy (the OneAPI client id). */
  excludeActorLogins?: string[]
}

/** The immutable marker recorded on every actor this module produces. */
const SOURCE = 'zscaler-audit'

/** Loose email shape — a ZIA `lastModifiedBy.name` is often the admin's login. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** Coerce a modifier id/name value to a trimmed string ('' when absent). */
function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * Convert a Zscaler epoch timestamp to an ISO-8601 string. Zscaler records
 * `lastModifiedTime` / `modifiedTime` as epoch SECONDS (ZIA as an integer, ZPA
 * as a numeric string); a value already in millisecond range is passed through
 * unscaled so both are handled. Returns undefined for a missing, zero, or
 * unparseable value.
 */
export function epochToIso(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n <= 0) return undefined
  const ms = n >= 1e12 ? n : n * 1000
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Narrow an unknown resource to the modifier fields we read (never throws). */
function readModifier(resource: unknown): { id: string; name: string; at?: string } | undefined {
  if (!resource || typeof resource !== 'object') return undefined
  const r = resource as ZscalerModifiedResource

  const ziaBy = r.lastModifiedBy && typeof r.lastModifiedBy === 'object' ? r.lastModifiedBy : null
  const name = ziaBy ? asText(ziaBy.name) : ''
  // ZIA id lives on the id/name pair; ZPA puts the id directly on `modifiedBy`.
  const id = ziaBy ? asText(ziaBy.id) : asText(r.modifiedBy)

  if (name === '' && id === '') return undefined

  const at = epochToIso(r.lastModifiedTime ?? null) ?? epochToIso(r.modifiedTime ?? null)
  return { id, name, at }
}

/**
 * Pick the actor from a live resource's modifier fields — PURE, so it is
 * unit-testable in isolation. Returns undefined when there is no modifier, or
 * when the modifier is an excluded (Veltrix) identity, so a resource we
 * deployed ourselves is never mis-attributed as a manual change.
 *
 * `name` always carries the human-readable value (the ZIA login/name, or the
 * id when that is all we have) so the UI has something to render; an
 * email-shaped identity is additionally exposed as `email`, and a non-email id
 * (a ZIA admin id or ZPA admin id) as `id`.
 */
export function pickActorFromResource(
  resource: unknown,
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  const modifier = readModifier(resource)
  if (!modifier) return undefined

  const display = modifier.name || modifier.id
  if (display === '') return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))
  if (excluded.size > 0) {
    const candidates = [display, modifier.name, modifier.id].map((v) => v.toLowerCase())
    if (candidates.some((c) => c !== '' && excluded.has(c))) return undefined
  }

  const actor: DriftActor = { source: SOURCE, name: display }
  if (EMAIL_RE.test(display)) actor.email = display
  if (modifier.id !== '' && !EMAIL_RE.test(modifier.id)) actor.id = modifier.id
  if (modifier.at) actor.at = modifier.at
  return actor
}

/**
 * Resolve WHO last changed a drifted Zscaler object and WHEN, from the modifier
 * fields on the live resource the drift check already fetched. Best-effort:
 * returns undefined on any error or missing/excluded modifier — attribution
 * never throws or fails a drift check.
 */
export function resolveDriftActor(
  resource: unknown,
  opts: ResolveDriftActorOptions = {},
): DriftActor | undefined {
  try {
    return pickActorFromResource(resource, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so all ~31 driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally. `resource` is `unknown`
 * so any config type's `Live*` shape passes without coupling this helper to it.
 */
export function attachDriftActor(
  diffs: object[],
  resource: unknown,
  opts: ResolveDriftActorOptions = {},
): void {
  if (!diffs || diffs.length === 0) return
  const actor = resolveDriftActor(resource, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The connection identity(ies) to treat as Veltrix (excluded from attribution).
 * The credential's username is the Zscaler OneAPI client id our deploys
 * authenticate with, so it is the identity our own changes are recorded under.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
