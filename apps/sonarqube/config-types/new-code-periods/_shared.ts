// Shared helpers for the SonarQube New Code Periods config type (validate + deploy +
// rollback + drift). Pure and network-free so validate.ts and the tests can use it.
//
// A new code period is authored as an optional project key, an optional branch (which
// requires project), a `type` and an optional `value`. Blank project+branch = the GLOBAL
// default; project only = a PROJECT-level override; both = a BRANCH-level override.
// Applied over the SonarQube Web API (/api/new_code_periods/set, /show, /unset).
//
// Verified live against a running SonarQube instance's own `api/webservices` reflection
// endpoints (api/webservices/list?include_internals=true, api/webservices/response_example).
// Since 8.0, all `new_code_periods` actions are public. `set` requires `type`:
// PREVIOUS_VERSION and NUMBER_OF_DAYS can be set at any level (global, project, branch);
// REFERENCE_BRANCH can only be set on a project or branch (never global); SPECIFIC_ANALYSIS
// can only be set on a branch (both project and branch required). `show` reflects
// inheritance — `inherited: true` means nothing is explicitly overridden at that exact
// level, so the response is the parent level's setting.

/** The four new-code-definition types the SonarQube Web API accepts. */
export const NEW_CODE_TYPES = new Set(['PREVIOUS_VERSION', 'NUMBER_OF_DAYS', 'REFERENCE_BRANCH', 'SPECIFIC_ANALYSIS'])

/** A new code period as returned by /api/new_code_periods/show. */
export interface NewCodePeriod {
  type?: string
  value?: string
  inherited?: boolean
  projectKey?: string
  branchKey?: string
}

/** Human-readable label for the level a (project, branch) pair addresses. */
export function levelLabel(project: unknown, branch: unknown): string {
  const p = String(project ?? '').trim()
  const b = String(branch ?? '').trim()
  if (!p && !b) return '(global)'
  if (!b) return p
  return `${p}#${b}`
}
