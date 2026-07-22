// =============================================================================
// CrowdStrike Falcon — drift attribution ("who changed it + when").
//
// When a config type detects that a live Falcon object has drifted from its
// deployed state, this resolves WHO made the last change and WHEN. Falcon
// records the modifier DIRECTLY on every managed resource, so — unlike a
// separate audit-log lookup — attribution reads the fields the drift check
// ALREADY fetched:
//   - Prevention Policy (GET /policy/combined/prevention/v1): modified_by (the
//     modifier's email) + modified_timestamp.
//   - Host Group (GET /devices/combined/host-groups/v1):       modified_by +
//     modified_timestamp.
//   - Custom IOC (GET /iocs/entities/indicators/v1):           modified_by (a
//     user/API-client uuid) + modified_on.
// This is the most reliable actor source (it is the resource's own record of
// its last writer) and adds no extra API call or scope.
//
// STRICTLY BEST-EFFORT: every entry point returns undefined rather than
// throwing, so attribution can NEVER break a drift check. A resource with no
// modifier field (e.g. a deleted object that no longer exists to read) is left
// unattributed and the diff is reported without an actor (the UI shows "—").
//
// Veltrix's own deploys run through the connection's API client, so a change
// WE made is recorded under that client's identity. To attribute the MANUAL
// change (not our own deploy), the caller passes the client id in
// `excludeActorLogins` and a resource last written by us is left unattributed.
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
 * The modifier fields this reads off a live Falcon resource. Prevention
 * policies and host groups use `modified_timestamp`; IOCs use `modified_on` —
 * both are read so one extractor serves all three config types.
 */
export interface ModifiedResource {
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

export interface ResolveDriftActorOptions {
  /** Connection identity(ies) to skip — Veltrix's own deploy (the API client id). */
  excludeActorLogins?: string[]
}

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** Loose email shape — prevention policy / host group modifiers are emails; IOC modifiers are uuids. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Pick the actor from a live resource's modifier fields — PURE, so it is
 * unit-testable in isolation. Returns undefined when there is no `modified_by`,
 * or when the modifier is an excluded (Veltrix) identity, so a resource we
 * deployed ourselves is never mis-attributed as a manual change. Maps an
 * email-shaped modifier to `email` and a uuid/opaque modifier to `id`; `name`
 * always carries the raw value so the UI has something to render.
 */
export function pickActorFromResource(
  resource: ModifiedResource | null | undefined,
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!resource || typeof resource !== 'object') return undefined

  const who = typeof resource.modified_by === 'string' ? resource.modified_by.trim() : ''
  if (who === '') return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))
  if (excluded.has(who.toLowerCase())) return undefined

  const at =
    typeof resource.modified_timestamp === 'string' && resource.modified_timestamp.trim()
      ? resource.modified_timestamp.trim()
      : typeof resource.modified_on === 'string' && resource.modified_on.trim()
        ? resource.modified_on.trim()
        : ''

  const actor: DriftActor = { source: 'crowdstrike-audit', name: who }
  if (EMAIL_RE.test(who)) actor.email = who
  else actor.id = who
  if (at !== '') actor.at = at
  return actor
}

/**
 * Resolve WHO last changed a drifted Falcon object and WHEN, from the modifier
 * fields on the live resource the drift check already fetched. Best-effort:
 * returns undefined on any error or missing/excluded modifier — attribution
 * never throws or fails a drift check.
 */
export function resolveDriftActor(
  resource: ModifiedResource | null | undefined,
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
 * here so all three driftDetect handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even on an SDK build whose `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export function attachDriftActor(
  diffs: object[],
  resource: ModifiedResource | null | undefined,
  opts: ResolveDriftActorOptions = {},
): void {
  if (!diffs || diffs.length === 0) return
  const actor = resolveDriftActor(resource, opts)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The connection identity(ies) to treat as Veltrix (excluded from attribution).
 * The credential's username is the Falcon API client id our deploys authenticate
 * with, so it is the identity our own changes are recorded under.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
