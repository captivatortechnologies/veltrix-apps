// Shared helpers for the Branch Protection (Classic) config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares the CLASSIC (non-ruleset) branch protection for one
// branch of a repository (`owner/repo` + `branch`), identified by that pair.
// This is a separate, still fully supported GitHub feature from Repository
// Rulesets — many organizations have not migrated off it. The endpoint
// replaces the ENTIRE protection object on every write (PUT), so deploy always
// sends the full desired shape.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/branches/branch-protection

/** The desired state one canvas item declares (raw JSON kept as text for validate to parse). */
export interface BranchProtectionDesired {
  repository: string
  branch: string
  requireStatusChecks: boolean
  strict: boolean
  contexts: string[]
  requirePullRequestReviews: boolean
  dismissStaleReviews: boolean
  requireCodeOwnerReviews: boolean
  requiredApprovingReviewCount: number
  requireLastPushApproval: boolean
  dismissalRestrictionsRaw: string
  bypassAllowancesRaw: string
  restrictPushes: boolean
  restrictionsRaw: string
  enforceAdmins: boolean
  requiredLinearHistory: boolean
  allowForcePushes: boolean
  allowDeletions: boolean
  blockCreations: boolean
  requiredConversationResolution: boolean
  lockBranch: boolean
  allowForkSyncing: boolean
}

/**
 * GitHub's READ shape for an actor list is richer than its WRITE shape: a PUT
 * takes plain login/slug strings, but a GET echoes full user/team/app objects.
 * This type covers both so one normalizer (`normalizeActorSet`) can compare
 * or convert either.
 */
export type LiveActorRef = string | { login?: string; slug?: string; name?: string }

export interface LiveActorSet {
  users?: LiveActorRef[]
  teams?: LiveActorRef[]
  apps?: LiveActorRef[]
}

/** GET /repos/{owner}/{repo}/branches/{branch}/protection — the slice this app reads. */
export interface LiveBranchProtection {
  required_status_checks?: { strict?: boolean; contexts?: string[] } | null
  enforce_admins?: { enabled?: boolean } | boolean | null
  required_pull_request_reviews?: {
    dismiss_stale_reviews?: boolean
    require_code_owner_reviews?: boolean
    required_approving_review_count?: number
    require_last_push_approval?: boolean
    dismissal_restrictions?: LiveActorSet
    bypass_pull_request_allowances?: LiveActorSet
  } | null
  restrictions?: LiveActorSet | null
  required_linear_history?: { enabled?: boolean } | boolean
  allow_force_pushes?: { enabled?: boolean } | boolean
  allow_deletions?: { enabled?: boolean } | boolean
  block_creations?: { enabled?: boolean } | boolean
  required_conversation_resolution?: { enabled?: boolean } | boolean
  lock_branch?: { enabled?: boolean } | boolean
  allow_fork_syncing?: { enabled?: boolean } | boolean
}

/** A single actor ref (write-shape string, or read-shape object) → its login/slug/name key. */
export function actorRefKey(ref: LiveActorRef | undefined): string {
  if (typeof ref === 'string') return ref.trim()
  if (ref && typeof ref === 'object') return (ref.login ?? ref.slug ?? ref.name ?? '').trim()
  return ''
}

/**
 * Normalize a users/teams/apps actor set — from EITHER shape — to sorted
 * plain-string arrays, so a desired (write-shape) set and a live (read-shape,
 * richer) set can be compared or converted with the same function.
 */
export function normalizeActorSet(value: LiveActorSet | null | undefined): { users: string[]; teams: string[]; apps: string[] } {
  return {
    users: (value?.users ?? []).map(actorRefKey).filter(Boolean).sort(),
    teams: (value?.teams ?? []).map(actorRefKey).filter(Boolean).sort(),
    apps: (value?.apps ?? []).map(actorRefKey).filter(Boolean).sort(),
  }
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

/** Coerce a canvas value ('true' | true | 'enabled' | 1 | ...) to a boolean. */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  return s === 'true' || s === 'enabled' || s === '1' || s === 'yes' || s === 'on'
}

/** GitHub reports a handful of booleans as either a raw boolean or `{ enabled }` — normalise both. */
export function readEnabled(value: { enabled?: boolean } | boolean | undefined | null): boolean {
  if (typeof value === 'boolean') return value
  return Boolean(value?.enabled)
}

/** Read a tags/array field (real array, or a comma/newline separated string as a fallback). */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

/** Parse a JSON object from text. Blank → an empty object (no error). */
export function parseJsonObject(raw: string): { value: Record<string, unknown>; error?: string } {
  const t = raw.trim()
  if (!t) return { value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    return { value: {}, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: {}, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown> }
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): BranchProtectionDesired {
  return {
    repository: String(fields.repository ?? '').trim(),
    branch: String(fields.branch ?? '').trim(),
    requireStatusChecks: normalizeBool(fields.require_status_checks, false),
    strict: normalizeBool(fields.strict, false),
    contexts: toStringArray(fields.contexts),
    requirePullRequestReviews: normalizeBool(fields.require_pull_request_reviews, false),
    dismissStaleReviews: normalizeBool(fields.dismiss_stale_reviews, false),
    requireCodeOwnerReviews: normalizeBool(fields.require_code_owner_reviews, false),
    requiredApprovingReviewCount: Math.min(6, Math.max(0, Number(fields.required_approving_review_count ?? 1) || 0)),
    requireLastPushApproval: normalizeBool(fields.require_last_push_approval, false),
    dismissalRestrictionsRaw: typeof fields.dismissal_restrictions === 'string' ? fields.dismissal_restrictions : jsonOrEmpty(fields.dismissal_restrictions),
    bypassAllowancesRaw: typeof fields.bypass_pull_request_allowances === 'string' ? fields.bypass_pull_request_allowances : jsonOrEmpty(fields.bypass_pull_request_allowances),
    restrictPushes: normalizeBool(fields.restrict_pushes, false),
    restrictionsRaw: typeof fields.restrictions === 'string' ? fields.restrictions : jsonOrEmpty(fields.restrictions),
    enforceAdmins: normalizeBool(fields.enforce_admins, false),
    requiredLinearHistory: normalizeBool(fields.required_linear_history, false),
    allowForcePushes: normalizeBool(fields.allow_force_pushes, false),
    allowDeletions: normalizeBool(fields.allow_deletions, false),
    blockCreations: normalizeBool(fields.block_creations, false),
    requiredConversationResolution: normalizeBool(fields.required_conversation_resolution, false),
    lockBranch: normalizeBool(fields.lock_branch, false),
    allowForkSyncing: normalizeBool(fields.allow_fork_syncing, false),
  }
}

function jsonOrEmpty(v: unknown): string {
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

/**
 * Build the full PUT body (branch protection is always a full replace).
 * Returns the body plus any JSON-parse errors so callers can fail an item
 * cleanly.
 */
export function buildProtectionBody(desired: BranchProtectionDesired): { body: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []

  const dismissal = parseJsonObject(desired.dismissalRestrictionsRaw)
  if (dismissal.error) errors.push(`dismissal_restrictions: ${dismissal.error}`)
  const bypass = parseJsonObject(desired.bypassAllowancesRaw)
  if (bypass.error) errors.push(`bypass_pull_request_allowances: ${bypass.error}`)
  const restrictions = parseJsonObject(desired.restrictionsRaw)
  if (restrictions.error) errors.push(`restrictions: ${restrictions.error}`)

  const body: Record<string, unknown> = {
    required_status_checks: desired.requireStatusChecks ? { strict: desired.strict, contexts: desired.contexts } : null,
    enforce_admins: desired.enforceAdmins,
    required_pull_request_reviews: desired.requirePullRequestReviews
      ? {
          dismiss_stale_reviews: desired.dismissStaleReviews,
          require_code_owner_reviews: desired.requireCodeOwnerReviews,
          required_approving_review_count: desired.requiredApprovingReviewCount,
          require_last_push_approval: desired.requireLastPushApproval,
          ...(Object.keys(dismissal.value).length > 0 ? { dismissal_restrictions: dismissal.value } : {}),
          ...(Object.keys(bypass.value).length > 0 ? { bypass_pull_request_allowances: bypass.value } : {}),
        }
      : null,
    restrictions: desired.restrictPushes
      ? { users: [], teams: [], apps: [], ...restrictions.value }
      : null,
    required_linear_history: desired.requiredLinearHistory,
    allow_force_pushes: desired.allowForcePushes,
    allow_deletions: desired.allowDeletions,
    block_creations: desired.blockCreations,
    required_conversation_resolution: desired.requiredConversationResolution,
    lock_branch: desired.lockBranch,
    allow_fork_syncing: desired.allowForkSyncing,
  }

  return { body, errors }
}

/**
 * Reconstruct the PUT body that restores a prior classic branch protection.
 * `prior` came from a GET, whose actor lists (restrictions, dismissal
 * restrictions, bypass allowances) are rich user/team/app objects — the PUT
 * body needs plain login/slug strings, so every actor set is normalized.
 */
export function restoreBody(prior: LiveBranchProtection): Record<string, unknown> {
  const reviews = prior.required_pull_request_reviews
  return {
    required_status_checks: prior.required_status_checks
      ? { strict: Boolean(prior.required_status_checks.strict), contexts: prior.required_status_checks.contexts ?? [] }
      : null,
    enforce_admins: readEnabled(prior.enforce_admins),
    required_pull_request_reviews: reviews
      ? {
          dismiss_stale_reviews: Boolean(reviews.dismiss_stale_reviews),
          require_code_owner_reviews: Boolean(reviews.require_code_owner_reviews),
          required_approving_review_count: reviews.required_approving_review_count ?? 1,
          require_last_push_approval: Boolean(reviews.require_last_push_approval),
          ...(reviews.dismissal_restrictions ? { dismissal_restrictions: normalizeActorSet(reviews.dismissal_restrictions) } : {}),
          ...(reviews.bypass_pull_request_allowances ? { bypass_pull_request_allowances: normalizeActorSet(reviews.bypass_pull_request_allowances) } : {}),
        }
      : null,
    restrictions: prior.restrictions ? normalizeActorSet(prior.restrictions) : null,
    required_linear_history: readEnabled(prior.required_linear_history),
    allow_force_pushes: readEnabled(prior.allow_force_pushes),
    allow_deletions: readEnabled(prior.allow_deletions),
    block_creations: readEnabled(prior.block_creations),
    required_conversation_resolution: readEnabled(prior.required_conversation_resolution),
    lock_branch: readEnabled(prior.lock_branch),
    allow_fork_syncing: readEnabled(prior.allow_fork_syncing),
  }
}

/** What deploy records per branch so rollback can restore or remove protection. */
export interface BranchProtectionRollbackEntry {
  repository: string
  branch: string
  /** Whether the branch was protected before THIS deploy. */
  existed: boolean
  /** The full prior protection object (existed=true only) so rollback can PUT it back. */
  prior?: LiveBranchProtection
}
