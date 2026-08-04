// Shared helpers for the Custom Repository Roles config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares ONE custom repository role for an organization —
// name, base role and the extra fine-grained permissions it grants — via
//   /orgs/{org}/custom-repository-roles
// (GitHub Enterprise Cloud only). Identified by (org, name). The permission
// catalog is GitHub's own and evolves independently of this app, so
// `permissions` is authored as a free-form list rather than a hardcoded enum
// (the same approach `org-security-configuration` takes for its
// `additional_settings` map).
// Docs (verified against docs.github.com/rest):
//   https://docs.github.com/en/rest/orgs/custom-roles

export const BASE_ROLE_VALUES = ['read', 'triage', 'write', 'maintain'] as const

/** A custom repository role as returned by GitHub. */
export interface CustomRepositoryRole {
  id?: number
  name?: string
  description?: string | null
  base_role?: string | null
  permissions?: string[]
  [key: string]: unknown
}

/** The desired state one canvas item declares. */
export interface CustomRoleDesired {
  org: string
  name: string
  description: string
  baseRole: string
  permissions: string[]
}

/** Read a tags/array field (real array, or a comma/newline separated string as a fallback). */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  return []
}

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): CustomRoleDesired {
  return {
    org: String(fields.org ?? '').trim(),
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    baseRole: (String(fields.base_role ?? 'read').trim().toLowerCase() || 'read'),
    permissions: toStringArray(fields.permissions),
  }
}

/** Build the full role body (create and update take the same shape). */
export function buildRoleBody(desired: CustomRoleDesired): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: desired.name,
    base_role: desired.baseRole,
    permissions: desired.permissions,
  }
  if (desired.description) body.description = desired.description
  return body
}

/** The subset of a desired body that differs from the live role (a PATCH diff). */
export function roleBodyChanges(desired: CustomRoleDesired, live: CustomRepositoryRole): Record<string, unknown> {
  const full = buildRoleBody(desired)
  const changes: Record<string, unknown> = {}
  if ((live.name ?? '') !== desired.name) changes.name = desired.name
  if ((live.description ?? '') !== desired.description) changes.description = desired.description
  if ((live.base_role ?? '') !== desired.baseRole) changes.base_role = desired.baseRole
  const livePerms = [...(live.permissions ?? [])].sort()
  const desiredPerms = [...desired.permissions].sort()
  if (JSON.stringify(livePerms) !== JSON.stringify(desiredPerms)) changes.permissions = full.permissions
  return changes
}

/** Reconstruct the PATCH body that restores a prior custom repository role. */
export function restoreBody(prior: CustomRepositoryRole): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (prior.name !== undefined) body.name = prior.name
  if (prior.description !== undefined) body.description = prior.description ?? ''
  if (prior.base_role !== undefined) body.base_role = prior.base_role
  if (prior.permissions !== undefined) body.permissions = prior.permissions
  return body
}

/** What deploy records per role so rollback can restore or delete it. */
export interface CustomRoleRollbackEntry {
  itemId?: string
  org: string
  name: string
  /** Whether the role existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** GitHub-assigned numeric id, kept so rollback/reconcile target it directly. */
  id?: number
  /** The full prior role (existed=true only) so rollback can PATCH it back. */
  prior?: CustomRepositoryRole
}
