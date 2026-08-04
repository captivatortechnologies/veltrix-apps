// Shared helpers for the Organization Role Assignments config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares that ONE team should hold ONE organization role —
// built-in (e.g. `security_manager`) or custom — via
//   PUT/DELETE /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}
// This is the GA replacement for the deprecated Security Managers API
// (`/orgs/{org}/security-managers/teams/{team_slug}`, closing down
// 2026-01-01 per GitHub's own docs), generalized to ANY organization role, not
// just `security_manager`. Roles are resolved by NAME against
// `GET /orgs/{org}/organization-roles` (case-insensitive) since role ids are
// assigned by GitHub and not something an operator would author directly.
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/orgs/organization-roles
//   https://docs.github.com/en/rest/orgs/security-managers (deprecation notice)

/** One organization role as returned by GET /orgs/{org}/organization-roles. */
export interface OrgRole {
  id?: number
  name?: string
  source?: string
}

/** One team as returned by GET /orgs/{org}/organization-roles/{role_id}/teams. */
export interface OrgRoleTeam {
  slug?: string
  name?: string
}

/** The desired state one canvas item declares. */
export interface OrgRoleAssignmentDesired {
  org: string
  team: string
  roleName: string
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): OrgRoleAssignmentDesired {
  return {
    org: String(fields.org ?? '').trim(),
    team: String(fields.team ?? '').trim(),
    roleName: String(fields.role_name ?? '').trim(),
  }
}

/** Find a role by name, case-insensitive. */
export function findRoleByName(roles: OrgRole[], name: string): OrgRole | undefined {
  const key = name.trim().toLowerCase()
  return roles.find((r) => (r.name ?? '').trim().toLowerCase() === key)
}

/** Whether a team slug appears in a role's assigned-teams list, case-insensitive. */
export function teamIsAssigned(teams: OrgRoleTeam[], teamSlug: string): boolean {
  const key = teamSlug.trim().toLowerCase()
  return teams.some((t) => (t.slug ?? '').trim().toLowerCase() === key)
}

/** What deploy records per assignment so rollback / reconcile can remove it. */
export interface OrgRoleAssignmentRollbackEntry {
  itemId?: string
  org: string
  team: string
  roleName: string
  roleId?: number
  /** Whether the team already held this role BEFORE this deploy (nothing to undo). */
  existed: boolean
}
