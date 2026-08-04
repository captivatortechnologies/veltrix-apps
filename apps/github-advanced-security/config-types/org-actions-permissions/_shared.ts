// Shared helpers for the Organization Actions Permissions config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares the desired GitHub Actions policy for one
// organization — which repositories may use Actions, which actions/reusable
// workflows are allowed, the default GITHUB_TOKEN workflow permissions, and
// whether third-party actions must be pinned by SHA. Actions SECRETS
// (org/repo secret values) are intentionally out of scope — see README
// Coverage notes (secret material, never round-trippable).
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/actions/permissions

export const ENABLED_REPOSITORIES_VALUES = ['all', 'none', 'selected'] as const
export const ALLOWED_ACTIONS_VALUES = ['all', 'local_only', 'selected'] as const
export const WORKFLOW_PERMISSIONS_VALUES = ['read', 'write'] as const

/** GET /orgs/{org}/actions/permissions. */
export interface OrgActionsPermissions {
  enabled_repositories?: string
  allowed_actions?: string
  sha_pinning_required?: boolean
}

/** GET /orgs/{org}/actions/permissions/repositories. */
export interface OrgActionsSelectedRepositories {
  total_count?: number
  repositories?: Array<{ id: number }>
}

/** GET /orgs/{org}/actions/permissions/selected-actions. */
export interface OrgActionsAllowedActions {
  github_owned_allowed?: boolean
  verified_allowed?: boolean
  patterns_allowed?: string[]
}

/** GET /orgs/{org}/actions/permissions/workflow. */
export interface OrgActionsWorkflowPermissions {
  default_workflow_permissions?: string
  can_approve_pull_request_reviews?: boolean
}

/** The desired state one canvas item declares. */
export interface OrgActionsPermissionsDesired {
  org: string
  enabledRepositories: string
  selectedRepositoryIds: number[]
  allowedActions: string
  githubOwnedAllowed: boolean
  verifiedAllowed: boolean
  patternsAllowed: string[]
  shaPinningRequired: boolean
  defaultWorkflowPermissions: string
  canApprovePullRequestReviews: boolean
}

/** Coerce a canvas value ('true' | true | 'enabled' | 1 | ...) to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === 'enabled' || s === '1' || s === 'yes' || s === 'on'
}

/** Parse a comma/space/newline separated list of repository ids into positive integers. */
export function parseIdList(value: unknown): number[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/** Read a tags/array field (real array, or a comma/newline separated string as a fallback). */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): OrgActionsPermissionsDesired {
  return {
    org: String(fields.org ?? '').trim(),
    enabledRepositories: (String(fields.enabled_repositories ?? 'all').trim().toLowerCase() || 'all'),
    selectedRepositoryIds: parseIdList(fields.selected_repository_ids),
    allowedActions: (String(fields.allowed_actions ?? 'all').trim().toLowerCase() || 'all'),
    githubOwnedAllowed: normalizeBool(fields.github_owned_allowed ?? true),
    verifiedAllowed: normalizeBool(fields.verified_allowed),
    patternsAllowed: toStringArray(fields.patterns_allowed),
    shaPinningRequired: normalizeBool(fields.sha_pinning_required),
    defaultWorkflowPermissions: (String(fields.default_workflow_permissions ?? 'read').trim().toLowerCase() || 'read'),
    canApprovePullRequestReviews: normalizeBool(fields.can_approve_pull_request_reviews),
  }
}

export function buildPermissionsBody(desired: OrgActionsPermissionsDesired): Record<string, unknown> {
  return {
    enabled_repositories: desired.enabledRepositories,
    allowed_actions: desired.allowedActions,
    sha_pinning_required: desired.shaPinningRequired,
  }
}

export function buildSelectedRepositoriesBody(desired: OrgActionsPermissionsDesired): Record<string, unknown> {
  return { selected_repository_ids: desired.selectedRepositoryIds }
}

export function buildAllowedActionsBody(desired: OrgActionsPermissionsDesired): Record<string, unknown> {
  return {
    github_owned_allowed: desired.githubOwnedAllowed,
    verified_allowed: desired.verifiedAllowed,
    patterns_allowed: desired.patternsAllowed,
  }
}

export function buildWorkflowBody(desired: OrgActionsPermissionsDesired): Record<string, unknown> {
  return {
    default_workflow_permissions: desired.defaultWorkflowPermissions,
    can_approve_pull_request_reviews: desired.canApprovePullRequestReviews,
  }
}

/** What deploy records per org so rollback can restore the prior policy. */
export interface OrgActionsPermissionsPrevious {
  org: string
  permissions: OrgActionsPermissions
  selectedRepositoryIds: number[] | null
  allowedActions: OrgActionsAllowedActions | null
  workflow: OrgActionsWorkflowPermissions
}
