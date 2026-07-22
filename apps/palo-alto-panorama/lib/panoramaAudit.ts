// =============================================================================
// Palo Alto Panorama — drift attribution ("who changed it + when").
//
// When a config type detects that a live Panorama object has drifted from its
// deployed state, this resolves WHO made the last manual change and WHEN by
// querying the PAN-OS config AUDIT LOG (the "config" log type). Every managed
// commit/edit records the administrator, the command and the changed xpath, so
// the log is the authoritative record of the last writer of an object. The
// result is attached to each DriftDiff as an optional `actor`, which the
// platform stores as-is and the drift view renders.
//
// The log API is asynchronous (start a job, then poll for the rows), so the
// PanoramaClient.fetchConfigLog helper bounds it tightly and this module treats
// the whole thing as STRICTLY BEST-EFFORT: every entry point returns undefined
// rather than throwing, so attribution can NEVER break — or even slow down — a
// drift check. On any error, an empty log, a timeout, or no usable human event
// the diff is reported without an actor and the drift view shows "—".
//
// Correlation: the config log's `path` / `full-path` is the xpath of the object
// that changed (e.g. .../address/entry[@name='web-1']/ip-netmask). A per-object
// query filters by name and the rows are then matched to the drifted object's
// name at a token boundary so a name is not mistaken for a longer one.
//
// Veltrix's own deploys run through the connection's admin identity, so they
// appear in the log under that admin. To attribute the MANUAL change (not our
// own deploy), the caller passes the connection username in `excludeActorLogins`
// and those rows are skipped.
//
// NOTE: the SDK's `DriftDiff` has no `actor` field, so this defines a LOCAL
// `DriftActor` (no SDK import) and sets it structurally via `diffs: object[]`.
// =============================================================================

import { extractXmlTag } from './panorama'

/** Attribution attached to a drifted diff. Local — the SDK DriftDiff has no `actor`. */
export interface DriftActor {
  id?: string
  name?: string
  email?: string
  at?: string
  eventType?: string
  source?: string
}

/** The config-log fields this reads off one `<entry>` row. */
export interface ConfigLogEntry {
  /** The administrator who made the change — mapped to the actor name. */
  admin?: string
  /** The config command (set / edit / delete / rename / move / commit ...). */
  cmd?: string
  /** When the change was recorded ("YYYY/MM/DD HH:MM:SS") — mapped to the actor time. */
  timeGenerated?: string
  /** Truncated xpath of the changed node. */
  path?: string
  /** Full xpath of the changed node — the reliable correlation target. */
  fullPath?: string
  /** "Succeeded" for an applied change; non-succeeded rows changed nothing. */
  result?: string
}

/** The narrow client surface this needs — PanoramaClient satisfies it structurally. */
export interface ConfigLogClient {
  fetchConfigLog(query: string, nlogs: number): Promise<{ ok: boolean; body: string }>
}

export interface ResolveDriftActorOptions {
  /** Name of the drifted object — drives the log query and the correlation. */
  objectName: string
  /** Connection admin(s) to skip — Veltrix's own deploy events. */
  excludeActorLogins?: string[]
  /** How many recent config-log rows to request (bounded; defaults to 10). */
  nlogs?: number
}

/** Small default page — the log is DESCENDING, so a few rows find the last change. */
const DEFAULT_NLOGS = 10

/**
 * cmd values that represent an actual EDIT to a managed object. A first pass
 * prefers these over activation-only commands (commit / validate) so the actor
 * is whoever made the change, not whoever pushed it; if none match it falls back
 * to the most recent usable row so attribution is still best-effort.
 */
const CHANGE_CMDS = new Set([
  'set',
  'edit',
  'delete',
  'rename',
  'move',
  'clone',
  'override',
  'multi-move',
  'multi-clone',
])

const normalizeLogin = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

const text = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '')

/**
 * A row is usable when it names an administrator and the change succeeded — the
 * config log has no human/service principal flag, so a named, succeeded admin is
 * the best-effort equivalent of "a human made this change". Failed rows changed
 * nothing and rows with no admin cannot be attributed.
 */
function isUsable(entry: ConfigLogEntry): boolean {
  if (text(entry.admin) === '') return false
  const result = text(entry.result).toLowerCase()
  return result === '' || result === 'succeeded'
}

/** True when the row's admin is one of the excluded (Veltrix) logins. */
function isExcluded(entry: ConfigLogEntry, excluded: Set<string>): boolean {
  if (excluded.size === 0) return false
  const admin = text(entry.admin).toLowerCase()
  return admin !== '' && excluded.has(admin)
}

/** True when the cmd is an object edit rather than an activation-only command. */
function isChangeCmd(cmd: string | undefined): boolean {
  return CHANGE_CMDS.has(text(cmd).toLowerCase())
}

/** Map a chosen config-log row to the DriftActor shape (only defined fields kept). */
function toActor(entry: ConfigLogEntry): DriftActor {
  const actor: DriftActor = { source: 'panorama-audit' }
  const admin = text(entry.admin)
  const at = text(entry.timeGenerated)
  const cmd = text(entry.cmd)
  if (admin) actor.name = admin
  if (at) actor.at = at
  if (cmd) actor.eventType = cmd
  return actor
}

/**
 * Parse the `<entry>` rows out of a config-log XML result body — PURE, so it is
 * unit-testable in isolation from the live log call. Each row's fields are read
 * within its own `<entry>...</entry>` block so the row-level `<result>` is not
 * confused with the response's wrapper `<result>`.
 */
export function parseConfigLogEntries(xml: string): ConfigLogEntry[] {
  if (typeof xml !== 'string' || xml.length === 0) return []
  const entries: ConfigLogEntry[] = []
  const rowRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
  let match: RegExpExecArray | null
  while ((match = rowRe.exec(xml)) !== null) {
    const block = match[1]
    entries.push({
      admin: extractXmlTag(block, 'admin') ?? undefined,
      cmd: extractXmlTag(block, 'cmd') ?? undefined,
      timeGenerated: extractXmlTag(block, 'time_generated') ?? undefined,
      path: extractXmlTag(block, 'path') ?? undefined,
      fullPath: extractXmlTag(block, 'full-path') ?? undefined,
      result: extractXmlTag(block, 'result') ?? undefined,
    })
  }
  return entries
}

/**
 * True when a config-log row's xpath references the named object. Matches the
 * name at a token boundary (treating `-` and `_` as word characters) so a short
 * name is not mistaken for a longer one — e.g. "web" does not match "web-server",
 * while `entry[@name='web']` and `.../web/...` both do.
 */
export function entryReferencesObject(entry: ConfigLogEntry, objectName: string): boolean {
  const name = text(objectName).toLowerCase()
  if (name === '') return false
  const hay = `${text(entry.path)} ${text(entry.fullPath)}`.toLowerCase()
  if (hay.trim() === '') return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`).test(hay)
}

/**
 * Pick the actor of the most relevant config-log row — PURE, so it is
 * unit-testable in isolation from the live log call. Considers only usable
 * (named admin, succeeded), non-excluded rows and sorts by `time_generated`
 * DESCENDING (defensively; the log is already descending). Prefers a row whose
 * cmd is an object edit; if none match, falls back to the most recent usable,
 * non-excluded row. Returns undefined when nothing usable remains.
 */
export function pickActorFromEvents(
  events: ConfigLogEntry[],
  excludeActorLogins: string[] = [],
): DriftActor | undefined {
  if (!Array.isArray(events) || events.length === 0) return undefined

  const excluded = new Set(excludeActorLogins.map(normalizeLogin).filter((l) => l !== ''))

  const candidates = events
    .filter((event) => isUsable(event) && !isExcluded(event, excluded))
    // "YYYY/MM/DD HH:MM:SS" is fixed-width, so a lexical sort is chronological.
    .sort((a, b) => text(b.timeGenerated).localeCompare(text(a.timeGenerated)))

  if (candidates.length === 0) return undefined

  const preferred = candidates.find((event) => isChangeCmd(event.cmd))
  return toActor(preferred ?? candidates[0])
}

/**
 * Build the config-log filter for one object. Names containing a single quote
 * would break the filter expression, so they are skipped (returns null) rather
 * than risk a malformed/injection-shaped query — attribution is best-effort, so
 * a skipped query simply yields no actor.
 */
export function buildConfigLogQuery(objectName: string): string | null {
  const name = text(objectName)
  if (name === '' || name.includes("'")) return null
  return `(path contains '${name}')`
}

/**
 * Resolve WHO last manually changed a drifted Panorama object and WHEN, from the
 * config audit log. Runs one bounded per-object query, correlates the returned
 * rows to the object by name, then picks the last human, non-Veltrix change.
 * Best-effort: returns undefined on any error, an unreachable/timed-out log, or
 * no usable row — attribution never throws or fails a drift check.
 */
export async function resolveDriftActor(
  client: ConfigLogClient,
  opts: ResolveDriftActorOptions,
): Promise<DriftActor | undefined> {
  try {
    const query = buildConfigLogQuery(opts.objectName)
    if (!query) return undefined
    const nlogs = typeof opts.nlogs === 'number' && opts.nlogs > 0 ? opts.nlogs : DEFAULT_NLOGS

    const res = await client.fetchConfigLog(query, nlogs)
    if (!res.ok) return undefined

    const entries = parseConfigLogEntries(res.body).filter((entry) =>
      entryReferencesObject(entry, opts.objectName),
    )
    return pickActorFromEvents(entries, opts.excludeActorLogins ?? [])
  } catch {
    // Attribution must never break drift detection.
    return undefined
  }
}

/**
 * Resolve the actor for a drifted object ONCE and attach it to every diff that
 * object produced. No-op when there are no diffs or no actor is resolved. Kept
 * here so every driftDetect flow wires attribution identically (DRY).
 *
 * `diffs` is typed as `object[]` so an SDK `DriftDiff[]` slice passes without a
 * cast at the call site even though the SDK's `DriftDiff` has no `actor` field;
 * the field is set structurally.
 */
export async function attachDriftActor(
  client: ConfigLogClient,
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
 * admin identity our own changes are recorded under in the config log.
 */
export function veltrixActorLogins(
  credential: { username?: string | null } | null | undefined,
): string[] {
  const username = credential?.username?.trim()
  return username ? [username] : []
}
