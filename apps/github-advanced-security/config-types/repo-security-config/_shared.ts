// Shared helpers for the Repository Security config type (deploy + rollback + drift).
//
// A canvas item declares the DESIRED on/off state of each GitHub Advanced Security
// feature for one repository (`owner/repo`). These helpers translate between the
// canvas booleans and the GitHub REST shapes:
//   - `security_and_analysis` on PATCH/GET /repos/{owner}/{repo}
//     (advanced_security, secret_scanning, secret_scanning_push_protection)
//   - the automated-security-fixes endpoint (Dependabot security updates)
//   - the code-scanning default-setup endpoint (state configured|not-configured)

/** The six feature keys a canvas item carries (identity + five booleans). */
export interface RepoSecurityDesired {
  repository: string
  advanced_security: boolean
  secret_scanning: boolean
  secret_scanning_push_protection: boolean
  dependabot_security_updates: boolean
  code_scanning_default_setup: boolean
}

/** One `{ status: 'enabled' | 'disabled' }` slot in the security_and_analysis object. */
export interface SecurityFeatureStatus {
  status?: 'enabled' | 'disabled' | string
}

/** The `security_and_analysis` object as returned by GET /repos and accepted by PATCH /repos. */
export interface SecurityAndAnalysis {
  advanced_security?: SecurityFeatureStatus
  secret_scanning?: SecurityFeatureStatus
  secret_scanning_push_protection?: SecurityFeatureStatus
  [key: string]: unknown
}

/** GET /repos/{owner}/{repo} — only the slice this app reads. */
export interface RepoResponse {
  full_name?: string
  private?: boolean
  security_and_analysis?: SecurityAndAnalysis | null
}

/** GET /repos/{owner}/{repo}/automated-security-fixes. */
export interface AutomatedSecurityFixes {
  enabled?: boolean
  paused?: boolean
}

/** GET /repos/{owner}/{repo}/code-scanning/default-setup. */
export interface CodeScanningDefaultSetup {
  state?: 'configured' | 'not-configured' | string
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

/** Read a canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): RepoSecurityDesired {
  return {
    repository: String(fields.repository ?? '').trim(),
    advanced_security: normalizeBool(fields.advanced_security),
    secret_scanning: normalizeBool(fields.secret_scanning),
    secret_scanning_push_protection: normalizeBool(fields.secret_scanning_push_protection),
    dependabot_security_updates: normalizeBool(fields.dependabot_security_updates),
    code_scanning_default_setup: normalizeBool(fields.code_scanning_default_setup),
  }
}

/** True when a security_and_analysis feature slot reports `status: "enabled"`. */
export function statusEnabled(slot: SecurityFeatureStatus | undefined): boolean {
  return slot?.status === 'enabled'
}

const flag = (on: boolean): SecurityFeatureStatus => ({ status: on ? 'enabled' : 'disabled' })

/**
 * Build the `security_and_analysis` PATCH body for the three features that live on
 * the repository object. GitHub applies advanced_security first within the same
 * request, so enabling secret scanning on a private repo alongside advanced
 * security works in one call.
 */
export function buildSecurityAndAnalysisPatch(desired: {
  advanced_security: boolean
  secret_scanning: boolean
  secret_scanning_push_protection: boolean
}): { security_and_analysis: SecurityAndAnalysis } {
  return {
    security_and_analysis: {
      advanced_security: flag(desired.advanced_security),
      secret_scanning: flag(desired.secret_scanning),
      secret_scanning_push_protection: flag(desired.secret_scanning_push_protection),
    },
  }
}

/** The three security_and_analysis booleans as GitHub currently reports them. */
export function securityAndAnalysisState(sa: SecurityAndAnalysis | null | undefined): {
  advanced_security: boolean
  secret_scanning: boolean
  secret_scanning_push_protection: boolean
} {
  return {
    advanced_security: statusEnabled(sa?.advanced_security),
    secret_scanning: statusEnabled(sa?.secret_scanning),
    secret_scanning_push_protection: statusEnabled(sa?.secret_scanning_push_protection),
  }
}

/** The code-scanning default-setup PATCH body for a desired on/off state. */
export function buildDefaultSetupPatch(enabled: boolean): { state: 'configured' | 'not-configured' } {
  return { state: enabled ? 'configured' : 'not-configured' }
}

/** True when the default-setup configuration is `configured`. */
export function defaultSetupEnabled(setup: CodeScanningDefaultSetup | null | undefined): boolean {
  return setup?.state === 'configured'
}

/** What deploy records per repository so rollback can restore the prior state. */
export interface RepoPreviousState {
  repository: string
  advanced_security: boolean
  secret_scanning: boolean
  secret_scanning_push_protection: boolean
  dependabot_security_updates: boolean
  code_scanning_default_setup: boolean
}
