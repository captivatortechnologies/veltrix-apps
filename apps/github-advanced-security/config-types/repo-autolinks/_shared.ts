// Shared helpers for the Repository Autolinks config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares ONE autolink reference for a repository (`owner/repo`)
// — a `key_prefix` (e.g. "TICKET-") that GitHub turns into a link using
// `url_template` (must contain `<num>`) wherever it appears in an issue, PR or
// commit message. Identified by (repository, key_prefix). GitHub's autolinks
// API has NO update endpoint — a changed url_template / is_alphanumeric is
// applied as a delete + create.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/repos/autolinks

/** The desired state one canvas item declares. */
export interface AutolinkDesired {
  repository: string
  keyPrefix: string
  urlTemplate: string
  isAlphanumeric: boolean
}

/** One autolink as returned by GitHub. */
export interface LiveAutolink {
  id?: number
  key_prefix?: string
  url_template?: string
  is_alphanumeric?: boolean
}

/** Coerce a canvas value ('true' | true | 'enabled' | 1 | ...) to a boolean. */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  return s === 'true' || s === 'enabled' || s === '1' || s === 'yes' || s === 'on'
}

/** `owner/repo` → { owner, repo }, or null when the value is not a valid full name. */
export function parseRepository(value: unknown): { owner: string; repo: string } | null {
  const raw = String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
  if (!raw) return null
  const parts = raw.split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts.map((p) => p.trim())
  if (!owner || !repo) return null
  return { owner, repo }
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): AutolinkDesired {
  return {
    repository: String(fields.repository ?? '').trim(),
    keyPrefix: String(fields.key_prefix ?? '').trim(),
    urlTemplate: String(fields.url_template ?? '').trim(),
    isAlphanumeric: normalizeBool(fields.is_alphanumeric, true),
  }
}

/** Build the POST body for a new autolink. */
export function buildAutolinkBody(desired: AutolinkDesired): Record<string, unknown> {
  return { key_prefix: desired.keyPrefix, url_template: desired.urlTemplate, is_alphanumeric: desired.isAlphanumeric }
}

/** Whether a live autolink already matches the desired shape (no delete+recreate needed). */
export function matchesLive(desired: AutolinkDesired, live: LiveAutolink): boolean {
  return (
    (live.key_prefix ?? '') === desired.keyPrefix &&
    (live.url_template ?? '') === desired.urlTemplate &&
    Boolean(live.is_alphanumeric) === desired.isAlphanumeric
  )
}

/** What deploy records per autolink so rollback / reconcile can restore or delete it. */
export interface AutolinkRollbackEntry {
  itemId?: string
  repository: string
  /** Whether an autolink existed (under the prior or desired key_prefix) before THIS deploy. */
  existed: boolean
  /** The GitHub-assigned id after this deploy (the current live autolink for this item). */
  id?: number
  /** The prior autolink's full shape (existed=true only), to recreate on rollback. */
  prior?: LiveAutolink
}
