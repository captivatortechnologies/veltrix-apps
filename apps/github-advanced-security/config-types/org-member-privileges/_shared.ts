// Shared helpers for the Organization Member Privileges config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares the desired member-privilege settings for one
// organization — default repository permission, what members may create, and
// web commit sign-off. Intentionally excludes `members_allowed_repository_creation_type`,
// which GitHub's own docs mark as closing down in favor of the granular
// `members_can_create_*_repositories` booleans this type already exposes.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/orgs/orgs#update-an-organization

export const DEFAULT_REPOSITORY_PERMISSION_VALUES = ['read', 'write', 'admin', 'none'] as const

/** GET /orgs/{org} — only the slice this app reads/writes. */
export interface OrgMemberPrivileges {
  default_repository_permission?: string
  members_can_create_repositories?: boolean
  members_can_create_public_repositories?: boolean
  members_can_create_private_repositories?: boolean
  members_can_create_internal_repositories?: boolean
  members_can_fork_private_repositories?: boolean
  members_can_create_pages?: boolean
  members_can_create_public_pages?: boolean
  members_can_create_private_pages?: boolean
  members_can_delete_repositories?: boolean
  members_can_delete_issues?: boolean
  web_commit_signoff_required?: boolean
}

/** The desired state one canvas item declares. */
export interface OrgMemberPrivilegesDesired extends Required<Omit<OrgMemberPrivileges, 'default_repository_permission'>> {
  org: string
  defaultRepositoryPermission: string
}

/** Coerce a canvas value ('true' | true | 'enabled' | 1 | ...) to a boolean. */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  return s === 'true' || s === 'enabled' || s === '1' || s === 'yes' || s === 'on'
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): OrgMemberPrivilegesDesired {
  return {
    org: String(fields.org ?? '').trim(),
    defaultRepositoryPermission: (String(fields.default_repository_permission ?? 'read').trim().toLowerCase() || 'read'),
    members_can_create_repositories: normalizeBool(fields.members_can_create_repositories, true),
    members_can_create_public_repositories: normalizeBool(fields.members_can_create_public_repositories, true),
    members_can_create_private_repositories: normalizeBool(fields.members_can_create_private_repositories, true),
    members_can_create_internal_repositories: normalizeBool(fields.members_can_create_internal_repositories, true),
    members_can_fork_private_repositories: normalizeBool(fields.members_can_fork_private_repositories, false),
    members_can_create_pages: normalizeBool(fields.members_can_create_pages, true),
    members_can_create_public_pages: normalizeBool(fields.members_can_create_public_pages, true),
    members_can_create_private_pages: normalizeBool(fields.members_can_create_private_pages, true),
    members_can_delete_repositories: normalizeBool(fields.members_can_delete_repositories, false),
    members_can_delete_issues: normalizeBool(fields.members_can_delete_issues, false),
    web_commit_signoff_required: normalizeBool(fields.web_commit_signoff_required, false),
  }
}

/** Build the PATCH /orgs/{org} body from a desired state. */
export function buildOrgPatch(desired: OrgMemberPrivilegesDesired): Record<string, unknown> {
  return {
    default_repository_permission: desired.defaultRepositoryPermission,
    members_can_create_repositories: desired.members_can_create_repositories,
    members_can_create_public_repositories: desired.members_can_create_public_repositories,
    members_can_create_private_repositories: desired.members_can_create_private_repositories,
    members_can_create_internal_repositories: desired.members_can_create_internal_repositories,
    members_can_fork_private_repositories: desired.members_can_fork_private_repositories,
    members_can_create_pages: desired.members_can_create_pages,
    members_can_create_public_pages: desired.members_can_create_public_pages,
    members_can_create_private_pages: desired.members_can_create_private_pages,
    members_can_delete_repositories: desired.members_can_delete_repositories,
    members_can_delete_issues: desired.members_can_delete_issues,
    web_commit_signoff_required: desired.web_commit_signoff_required,
  }
}

/** What deploy records per org so rollback can restore the prior privileges. */
export interface OrgMemberPrivilegesPrevious {
  org: string
  prior: OrgMemberPrivileges
}
