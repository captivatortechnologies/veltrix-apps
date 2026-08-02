// Shared helpers for the Password Safe User Groups config type (deploy +
// rollback + drift). Pure and network-free — the __tests__ exercise validate.ts
// and these helpers, none of which touch the network.
//
// This config type manages BeyondInsight-TYPE user groups only (groupType
// "BeyondInsight"). Active Directory / LDAP / Entra ID groups require a bound
// directory + a stored credential (a parent graph) and are intentionally out of
// scope.
//
// Endpoints follow the BeyondInsight / Password Safe public v3 API — verify
// against a live BeyondTrust instance:
//   GET    /UserGroups          list all groups
//   POST   /UserGroups          create a BeyondInsight group
//   DELETE /UserGroups/{id}     delete by group id
// There is NO update (PUT) endpoint for a user group, so a change to an existing
// group means delete + recreate (which drops its permissions + members) and is
// never done implicitly — create-if-absent upsert, same posture as functional
// accounts.
//
// FLAGGED (unverified): POST /UserGroups create body carries only the documented
// required fields (groupType, groupName, description) plus isActive. Permissions,
// SmartRuleAccess and ApplicationRegistrationIDs are NOT managed here — a group is
// created without feature permissions and an admin grants them in BeyondInsight.
// Whether a given instance rejects a create that omits an (empty) Permissions
// array has not been verified against a live instance.

/** Max lengths from the BeyondInsight API guide (POST UserGroups, BeyondInsight group). */
export const GROUP_NAME_MAX = 200
export const GROUP_DESCRIPTION_MAX = 255

/** One user group as returned by GET /UserGroups (field casing varies by version). */
export interface UserGroup {
  GroupID?: number | string
  UserGroupID?: number | string
  ID?: number | string
  Name?: string
  GroupName?: string
  Description?: string | null
  GroupType?: string | null
  IsActive?: boolean
  [key: string]: unknown
}

/** The create body POSTed to /UserGroups for a BeyondInsight group. */
export interface UserGroupCreate {
  groupType: 'BeyondInsight'
  groupName: string
  description: string
  isActive: boolean
}

/** Trim any value to a string. */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a canvas checkbox/string to a boolean, defaulting to `fallback` when blank. */
export function toBool(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value
  if (value === null || value === undefined || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

/** A BeyondInsight group's identity is its name, case-folded (names are unique). */
export function groupIdentity(name: unknown): string {
  return str(name).toLowerCase()
}

/** Unwrap either a plain array or a `{ Data: [...] }` paginated container. */
export function groupsFromList(data: unknown): UserGroup[] {
  if (Array.isArray(data)) return data as UserGroup[]
  if (data && typeof data === 'object' && Array.isArray((data as { Data?: unknown }).Data)) {
    return (data as { Data: UserGroup[] }).Data
  }
  return []
}

/** The group id used by DELETE /UserGroups/{id}, across response shapes. */
export function groupIdOf(group: UserGroup): number | string | null {
  return group.GroupID ?? group.UserGroupID ?? group.ID ?? null
}

/** The group's display name across response shapes. */
export function groupNameOf(group: UserGroup): string {
  return str(group.Name ?? group.GroupName)
}

/** Find a live group by its (case-insensitive) name. */
export function findUserGroup(groups: UserGroup[], name: unknown): UserGroup | null {
  const wanted = groupIdentity(name)
  return groups.find((g) => groupIdentity(groupNameOf(g)) === wanted) ?? null
}

/** Build the /UserGroups create body from canvas fields. */
export function buildCreateBody(fields: Record<string, unknown>): UserGroupCreate {
  return {
    groupType: 'BeyondInsight',
    groupName: str(fields.groupName),
    description: str(fields.description),
    isActive: toBool(fields.isActive, true),
  }
}
