// Shared helpers for the Secret Scanning Options config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares the desired on/off state of the ADVANCED
// secret-scanning sub-settings on `security_and_analysis` for one repository
// (`owner/repo`) — validity checks, non-provider patterns, AI-assisted
// detection of generic secrets, delegated alert dismissal and delegated push
// protection bypass (with its reviewer list). These are COMPLEMENTARY to (and
// patch different sub-keys than) `repo-security-config`'s base
// `secret_scanning` / `secret_scanning_push_protection` toggles — GitHub's
// `security_and_analysis` PATCH merges only the keys sent, so the two config
// types can manage the same repository independently.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/repos/repos#update-a-repository (security_and_analysis)

/** One `{ status: 'enabled' | 'disabled' }` slot in the security_and_analysis object. */
export interface FeatureStatus {
  status?: 'enabled' | 'disabled' | string
}

/** One delegated-bypass reviewer, e.g. `{ reviewer_id: 123, reviewer_type: "TEAM" }`. */
export interface DelegatedBypassReviewer {
  reviewer_id: number
  reviewer_type: string
  [key: string]: unknown
}

/** The slice of `security_and_analysis` this config type reads/writes. */
export interface SecretScanningOptionsBlock {
  secret_scanning_validity_checks?: FeatureStatus
  secret_scanning_non_provider_patterns?: FeatureStatus
  secret_scanning_ai_detection?: FeatureStatus
  secret_scanning_delegated_alert_dismissal?: FeatureStatus
  secret_scanning_delegated_bypass?: FeatureStatus
  secret_scanning_delegated_bypass_options?: { reviewers?: DelegatedBypassReviewer[] }
}

/** GET /repos/{owner}/{repo} — only the slice this app reads. */
export interface RepoResponse {
  security_and_analysis?: SecretScanningOptionsBlock | null
}

/** The desired state one canvas item declares. */
export interface SecretScanningOptionsDesired {
  repository: string
  validityChecks: boolean
  nonProviderPatterns: boolean
  aiDetection: boolean
  delegatedAlertDismissal: boolean
  delegatedBypass: boolean
  delegatedBypassReviewersRaw: string
}

/** Coerce a canvas value ('true' | true | 'enabled' | 1 | ...) to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
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

/** Parse a JSON array of delegated-bypass reviewers from text. Blank → an empty array. */
export function parseReviewers(raw: string): { value: DelegatedBypassReviewer[]; error?: string } {
  const t = raw.trim()
  if (!t) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    return { value: [], error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  return { value: parsed as DelegatedBypassReviewer[] }
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): SecretScanningOptionsDesired {
  const reviewers = fields.delegated_bypass_reviewers
  return {
    repository: String(fields.repository ?? '').trim(),
    validityChecks: normalizeBool(fields.secret_scanning_validity_checks),
    nonProviderPatterns: normalizeBool(fields.secret_scanning_non_provider_patterns),
    aiDetection: normalizeBool(fields.secret_scanning_ai_detection),
    delegatedAlertDismissal: normalizeBool(fields.secret_scanning_delegated_alert_dismissal),
    delegatedBypass: normalizeBool(fields.secret_scanning_delegated_bypass),
    delegatedBypassReviewersRaw: typeof reviewers === 'string' ? reviewers : reviewers != null ? JSON.stringify(reviewers) : '',
  }
}

const flag = (on: boolean): FeatureStatus => ({ status: on ? 'enabled' : 'disabled' })

/** Build the `security_and_analysis` PATCH body for this type's five sub-keys. */
export function buildSecretScanningOptionsPatch(
  desired: SecretScanningOptionsDesired,
): { body: { security_and_analysis: SecretScanningOptionsBlock }; errors: string[] } {
  const errors: string[] = []
  const reviewers = parseReviewers(desired.delegatedBypassReviewersRaw)
  if (reviewers.error) errors.push(`delegated_bypass_reviewers: ${reviewers.error}`)

  const block: SecretScanningOptionsBlock = {
    secret_scanning_validity_checks: flag(desired.validityChecks),
    secret_scanning_non_provider_patterns: flag(desired.nonProviderPatterns),
    secret_scanning_ai_detection: flag(desired.aiDetection),
    secret_scanning_delegated_alert_dismissal: flag(desired.delegatedAlertDismissal),
    secret_scanning_delegated_bypass: flag(desired.delegatedBypass),
  }
  if (desired.delegatedBypass && reviewers.value.length > 0) {
    block.secret_scanning_delegated_bypass_options = { reviewers: reviewers.value }
  }
  return { body: { security_and_analysis: block }, errors }
}

/** This type's five booleans as GitHub currently reports them. */
export function liveState(sa: SecretScanningOptionsBlock | null | undefined): {
  validityChecks: boolean
  nonProviderPatterns: boolean
  aiDetection: boolean
  delegatedAlertDismissal: boolean
  delegatedBypass: boolean
} {
  return {
    validityChecks: sa?.secret_scanning_validity_checks?.status === 'enabled',
    nonProviderPatterns: sa?.secret_scanning_non_provider_patterns?.status === 'enabled',
    aiDetection: sa?.secret_scanning_ai_detection?.status === 'enabled',
    delegatedAlertDismissal: sa?.secret_scanning_delegated_alert_dismissal?.status === 'enabled',
    delegatedBypass: sa?.secret_scanning_delegated_bypass?.status === 'enabled',
  }
}

/** What deploy records per repository so rollback can restore the prior state. */
export interface SecretScanningOptionsPrevious {
  repository: string
  block: SecretScanningOptionsBlock
}

/** Reconstruct the PATCH body that restores a prior security_and_analysis slice. */
export function restorePatch(prior: SecretScanningOptionsBlock): { security_and_analysis: SecretScanningOptionsBlock } {
  return { security_and_analysis: prior }
}
