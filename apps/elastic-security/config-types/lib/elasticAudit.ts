// =============================================================================
// Elastic Security — drift attribution ("who changed it + when").
//
// When a config type detects that a live Elastic object has drifted from its
// deployed state, this resolves WHO made the last change and WHEN. Elastic
// records the modifier DIRECTLY on the objects the drift check already fetches,
// so — unlike a separate audit-log lookup — attribution reads fields that are
// already in hand:
//   - Kibana detection rules (GET /api/detection_engine/rules):    updated_by /
//     updated_at (created_by / created_at fall back for a never-updated object).
//   - Kibana exception lists + items (GET /api/exception_lists...): updated_by /
//     updated_at (created_by / created_at fall back).
// The LAST writer (updated_by) is the person who made the manual change, so it
// is preferred over the original creator. This is the most reliable actor source
// (it is the object's own record of its last writer) and adds no extra API call
// or privilege.
//
// NOT every Elastic object carries a modifier: Elasticsearch ILM policies expose
// only `modified_date` (no user), and Elasticsearch role mappings and Kibana
// spaces carry no modifier fields at all — and neither surfaces a per-object
// audit trail through this app's API. Those objects resolve to no actor and are
// left unattributed (the drift view shows "—") rather than fabricating one.
//
// STRICTLY BEST-EFFORT: every entry point returns undefined rather than
// throwing, so attribution can NEVER break a drift check. A deleted object (one
// that no longer exists to read) is reported as drift without an actor.
//
// Veltrix's own deploys authenticate with the connection's credential, so a
// change WE made is recorded under that identity. To attribute the MANUAL change
// (not our own deploy), the caller passes the connection identity in
// `excludeActorLogins` and an object last written by us is left unattributed.
// =============================================================================

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
 * The modifier fields this reads off a live Elastic object. Kibana objects
 * populate `updated_by` / `updated_at` (preferred — the last writer) and
 * `created_by` / `created_at` (fallback). The public entry points take `unknown`
 * (the drifted object's own type, which does not declare these fields) and
 * narrow to this shape, so every config type passes its live object with no cast;
 * each value is checked with a typeof guard before use.
 */
export interface ModifiedResource {
  updated_by?: unknown
  updated_at?: unknown
  created_by?: unknown
  created_at?: unknown
}

export interface ResolveDriftActorOptions {
  /** Connection identity(ies) to skip — Veltrix's own deploy (the credential login). */
  excludeActorLogins?: string[]
}

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** Read a field as a trimmed string, or '' when it is absent / not a string. */
const asTrimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

/** Loose email shape — an Elastic principal MAY be an email (SSO) or a bare username. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Pick the actor from a live object's modifier fields — PURE, so it is
 * unit-testable in isolation. Prefers `updated_by` / `updated_at` (the last
 * writer = who made the manual change) and falls back to `created_by` /
 * `created_at`. Returns undefined when there is no modifier, or when the modifier
 * is an excluded (Veltrix) identity, so an object we deployed ourselves is never
 * mis-attributed as a manual change. Maps an email-shaped modifier to `email` and
 * a bare username to `id`; `name` always carries the raw value so the UI has
 * something to render.
 */
export function pickActorFromResource(
  resource: unknown,
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!resource || typeof resource !== 'object') return undefined
  const mod = resource as ModifiedResource

  const updatedBy = asTrimmedString(mod.updated_by)
  const createdBy = asTrimmedString(mod.created_by)

  // The LAST writer is the manual changer; fall back to the creator only when no
  // update is recorded (an object that was created but never modified).
  let who = ''
  let at = ''
  if (updatedBy !== '') {
    who = updatedBy
    at = asTrimmedString(mod.updated_at)
  } else if (createdBy !== '') {
    who = createdBy
    at = asTrimmedString(mod.created_at)
  }
  if (who === '') return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))
  if (excluded.has(who.toLowerCase())) return undefined

  const actor: DriftActor = { source: 'elastic-audit', name: who }
  if (EMAIL_RE.test(who)) actor.email = who
  else actor.id = who
  if (at !== '') actor.at = at
  return actor
}

/**
 * Resolve WHO last changed a drifted Elastic object and WHEN, from the modifier
 * fields on the live object the drift check already fetched. Best-effort: returns
 * undefined on any error or missing/excluded modifier — attribution never throws
 * or fails a drift check.
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
 * here so every driftDetect handler wires attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
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
 * The credential's username is the login our deploys authenticate as, so it is
 * the identity Elastic records our own changes under.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
