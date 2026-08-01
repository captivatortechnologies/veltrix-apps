// Shared helpers for the Dependabot Configuration config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares the DESIRED on/off state of Dependabot alerts and
// Dependabot security updates for one repository (owner/repo). These map to two
// dedicated GitHub REST endpoints (verified against docs.github.com/rest):
//   - Dependabot alerts (vulnerability alerts + dependency graph):
//       GET   /repos/{owner}/{repo}/vulnerability-alerts   (204 enabled / 404 disabled)
//       PUT   /repos/{owner}/{repo}/vulnerability-alerts    (enable)
//       DELETE /repos/{owner}/{repo}/vulnerability-alerts   (disable)
//   - Dependabot security updates (automated security fixes):
//       GET   /repos/{owner}/{repo}/automated-security-fixes  ({ enabled, paused })
//       PUT/DELETE /repos/{owner}/{repo}/automated-security-fixes

/** The desired Dependabot state one canvas item declares (identity + two booleans). */
export interface DependabotDesired {
  repository: string
  vulnerability_alerts: boolean
  security_updates: boolean
}

/** GET /repos/{owner}/{repo}/automated-security-fixes. */
export interface AutomatedSecurityFixes {
  enabled?: boolean
  paused?: boolean
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

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): DependabotDesired {
  return {
    repository: String(fields.repository ?? '').trim(),
    vulnerability_alerts: normalizeBool(fields.vulnerability_alerts),
    security_updates: normalizeBool(fields.security_updates),
  }
}

/** What deploy records per repository so rollback can restore the prior Dependabot state. */
export interface DependabotPreviousState {
  repository: string
  vulnerability_alerts: boolean
  security_updates: boolean
}
