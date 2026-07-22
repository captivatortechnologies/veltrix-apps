// =============================================================================
// Defender for Endpoint drift attribution — "who changed it + when".
//
// When a config type detects that a live Defender object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN. Unlike
// Intune/Okta (which query a separate audit-events endpoint), the Defender APIs
// expose NO config-change audit log for the objects this app manages — but every
// managed object natively carries first-party "who created / last modified + when"
// stamps, so attribution is read straight off the object the drift check already
// fetched (no extra API call):
//   - Indicators (/api/indicators): createdBy + createdBySource + sourceType
//     (User vs AadApp) + creationTimeDateTimeUtc, and lastUpdatedBy + lastUpdateTime.
//   - Detection rules (Graph beta /security/rules/detectionRules): createdBy +
//     createdDateTime, and lastModifiedBy + lastModifiedDateTime.
//
// Those stamps are normalized into up-to-two pseudo-events (a create and an
// update) per object and fed to the SAME pure `pickActorFromEvents` core as the
// other apps: human only, exclude the Veltrix identity, prefer the change
// (update) event, fall back to the most recent human event.
//
// STRICTLY BEST-EFFORT: every entry point is wrapped so attribution can NEVER
// throw or fail a drift check. On any error or no usable human event it yields
// undefined and the diff is reported without an actor (the UI shows "—"). A
// DELETED object is unattributable here — its stamps are gone with it and there
// is no audit log to name the deleter.
//
// Veltrix deploys run app-only (OAuth2 client credentials), so the objects it
// writes are stamped with the app registration identity: indicators get
// sourceType `AadApp` (dropped by the human-only filter) and detection rules get
// a non-UPN app name (dropped by the same filter). As a second guard the
// connection Client ID (appId) is passed in `excludeActorLogins` and skipped, so
// attribution reflects the MANUAL change, not our own deploy.
//
// NOTE ON TYPES: defender-endpoint typechecks against an SDK build whose
// `DriftDiff` has no `actor` field, so this module declares its OWN `DriftActor`
// (it never imports one from the SDK) and sets the field STRUCTURALLY on an
// `object[]`, adding zero new tsc errors.
// =============================================================================

/** Attribution attached to a drifted diff (a local shape — see the type note above). */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** A normalized audit stamp derived from one live object's create/update metadata. */
export interface MdeAuditEvent {
  /** The actor identity string (UPN / app name / app id), if any. */
  actor?: string
  /** ISO timestamp of the stamp, if any. */
  at?: string
  /** 'created' | 'updated' — surfaced as the diff's eventType. */
  eventType?: string
  /** Whether the actor is a (likely) human — reliable for indicators via sourceType. */
  human: boolean
  /** Whether this stamp represents a change (the update stamp) vs the create fallback. */
  change: boolean
}

/** The Indicator audit stamps this reads (a subset of the /api/indicators resource). */
export interface IndicatorAudit {
  createdBy?: string | null
  createdBySource?: string | null
  sourceType?: string | null
  creationTimeDateTimeUtc?: string | null
  lastUpdatedBy?: string | null
  lastUpdateTime?: string | null
}

/** The detection-rule audit stamps this reads (a subset of the Graph resource). */
export interface RuleAudit {
  createdBy?: string | null
  createdDateTime?: string | null
  lastModifiedBy?: string | null
  lastModifiedDateTime?: string | null
}

const normalize = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/** A non-empty trimmed string, or null. */
function strOrNull(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : ''
  return s.length > 0 ? s : null
}

/** Best-effort human signal: a user principal name / email carries an "@". */
function looksHuman(id: string | null | undefined): boolean {
  return normalize(id).includes('@')
}

/** True when the actor is one of the excluded (Veltrix app) identities. */
function isExcludedActor(actor: string | undefined, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const n = normalize(actor)
  return n !== '' && excluded.has(n)
}

/** Map a chosen audit event to the DriftActor shape (only defined fields kept). */
function toActor(event: MdeAuditEvent): DriftActor {
  const actor: DriftActor = { source: 'defender-audit' }
  const id = strOrNull(event.actor)
  if (id) {
    actor.name = id
    if (id.includes('@')) actor.email = id
  }
  if (event.at) actor.at = event.at
  if (event.eventType) actor.eventType = event.eventType
  return actor
}

/**
 * Pick the actor of the most relevant event — PURE, so it is unit-testable in
 * isolation from any live call. Considers only human, non-excluded events, and
 * sorts by timestamp DESCENDING so it is order-independent. Prefers the change
 * (update) event; if none qualifies, falls back to the most recent human,
 * non-excluded event. Returns undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  events: MdeAuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalize).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => event.human && !isExcludedActor(event.actor, excluded))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => event.change)
  return toActor(preferred ?? candidates[0])
}

/**
 * Derive the create + update pseudo-events from a live indicator. `sourceType`
 * (`User` vs `AadApp`) is the reliable human signal for the create stamp; the
 * update stamp has no sourceType, so it uses the best-effort UPN ("@") heuristic.
 */
export function indicatorAuditEvents(indicator: IndicatorAudit): MdeAuditEvent[] {
  const events: MdeAuditEvent[] = []

  const createdActor = strOrNull(indicator.createdBy) ?? strOrNull(indicator.createdBySource)
  const createdAt = strOrNull(indicator.creationTimeDateTimeUtc)
  if (createdActor || createdAt) {
    const sourceType = normalize(indicator.sourceType)
    events.push({
      actor: createdActor ?? undefined,
      at: createdAt ?? undefined,
      eventType: 'created',
      human: sourceType ? sourceType === 'user' : looksHuman(createdActor),
      change: false,
    })
  }

  const updatedActor = strOrNull(indicator.lastUpdatedBy)
  const updatedAt = strOrNull(indicator.lastUpdateTime)
  if (updatedActor || updatedAt) {
    events.push({
      actor: updatedActor ?? undefined,
      at: updatedAt ?? undefined,
      eventType: 'updated',
      human: looksHuman(updatedActor),
      change: true,
    })
  }

  return events
}

/**
 * Derive the create + update pseudo-events from a live detection rule. Graph
 * exposes no human-vs-app flag, so both stamps use the best-effort UPN ("@")
 * heuristic; app-authored stamps (a non-UPN app name/id) are dropped as non-human.
 */
export function ruleAuditEvents(rule: RuleAudit): MdeAuditEvent[] {
  const events: MdeAuditEvent[] = []

  const createdActor = strOrNull(rule.createdBy)
  const createdAt = strOrNull(rule.createdDateTime)
  if (createdActor || createdAt) {
    events.push({
      actor: createdActor ?? undefined,
      at: createdAt ?? undefined,
      eventType: 'created',
      human: looksHuman(createdActor),
      change: false,
    })
  }

  const modifiedActor = strOrNull(rule.lastModifiedBy)
  const modifiedAt = strOrNull(rule.lastModifiedDateTime)
  if (modifiedActor || modifiedAt) {
    events.push({
      actor: modifiedActor ?? undefined,
      at: modifiedAt ?? undefined,
      eventType: 'updated',
      human: looksHuman(modifiedActor),
      change: true,
    })
  }

  return events
}

/**
 * Resolve WHO last manually changed a drifted object and WHEN from its derived
 * audit events. Best-effort: returns undefined on any error or no usable human
 * event — attribution never throws or fails a drift check.
 */
export function resolveDriftActor(
  events: MdeAuditEvent[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  try {
    return pickActorFromEvents(events, excludeActorLogins)
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so all drift handlers wire attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even though the SDK build's `DriftDiff` predates the
 * optional `actor` field; the field is set structurally.
 */
export function attachDriftActor(
  diffs: object[],
  events: MdeAuditEvent[],
  excludeActorLogins: string[] = [],
): void {
  if (!diffs || diffs.length === 0) return
  const actor = resolveDriftActor(events, excludeActorLogins)
  if (!actor) return
  for (const diff of diffs) (diff as { actor?: DriftActor }).actor = actor
}

/**
 * The Veltrix identity to exclude from attribution. Deploys authenticate as the
 * app registration (OAuth2 client credentials), so the credential's `username` —
 * the Client ID / appId — is the identity our own changes are stamped under.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const clientId = credential?.username?.trim()
  return clientId ? [clientId] : []
}
