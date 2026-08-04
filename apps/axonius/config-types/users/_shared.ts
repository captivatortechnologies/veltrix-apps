// Shared helpers for the Axonius Users config type (deploy + rollback + drift +
// validate). Manages Axonius-INTERNAL system-user accounts (source "internal")
// assigned to a role — never LDAP/SAML/SSO-provisioned accounts, which this
// config type never matches or touches. Passwords are never read, written, or
// stored anywhere in this config type: create always requests an
// Axonius-generated password (auto_generated_password), and update never
// includes a password field — the operator resets a user's password through
// Axonius's own reset-link flow, not through config-as-code. Shapes follow the
// axonius-api-client JSON:API surface; verify against a live Axonius tenant.
//
// Endpoints (verified against axonius_api_client master — api_endpoints.py,
// json_api/system_users.py, json_api/resources.py):
//   GET    api/settings/users         list users (type_ users_details_schema)
//   POST   api/settings/users         create (type_ create_user_schema)
//   PUT    api/settings/users/{uuid}  update (type_ users_schema, no uuid in body —
//                                     SystemUserUpdateSchema.post_dump_fixit pops it)
//   DELETE api/settings/users/{uuid}  delete — body IS required (ResourceDeleteSchema
//                                     declares no Meta.type_, so it inherits
//                                     BaseSchemaJson's default type_ "base_schema";
//                                     verified against json_api/base.py). FLAG: this
//                                     unusual shape is source-derived, not tenant-tested.

/** JSON:API resource type for the create body (create_user_schema). */
const CREATE_USER_SCHEMA_TYPE = 'create_user_schema'
/** JSON:API resource type for the update body (users_schema). */
const UPDATE_USER_SCHEMA_TYPE = 'users_schema'
/** JSON:API resource type inherited by the generic delete body (base.py BaseSchemaJson default). */
const DELETE_USER_SCHEMA_TYPE = 'base_schema'

/** Max page size, matching the pagination style already used by saved-queries. */
export const MAX_PAGE_SIZE = 2000

/** Axonius marks a locally-created system user with this `source` value. */
export const INTERNAL_SOURCE = 'internal'

// --- Endpoint resource paths (relative to the API root, e.g. `api/`) ----------

/** GET — list every user (one generous page for identity-matching + drift). */
export const USERS_LIST_RESOURCE = `settings/users?page[limit]=${MAX_PAGE_SIZE}&page[offset]=0`
/** POST — create a user. */
export const CREATE_USER_RESOURCE = 'settings/users'
/** PUT — update a user by uuid. */
export function updateUserResource(uuid: string): string {
  return `settings/users/${encodeURIComponent(uuid)}`
}
/** DELETE — remove a user by uuid. */
export function deleteUserResource(uuid: string): string {
  return `settings/users/${encodeURIComponent(uuid)}`
}

// --- Types --------------------------------------------------------------------

/** The subset of a live Axonius user this config type reads and manages. */
export interface AxoniusUser {
  id?: string
  uuid?: string
  user_name?: string
  role_id?: string
  role_name?: string
  email?: string
  first_name?: string
  last_name?: string
  title?: string
  department?: string
  source?: string
  ignore_role_assignment_rules?: boolean
  [key: string]: unknown
}

// --- Field parsing --------------------------------------------------------

/** Trim a string canvas value. */
export function parseText(value: unknown): string {
  return String(value ?? '').trim()
}

/** Read a `checkbox` canvas field as a strict boolean. */
export function parseBool(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Whether a live user record is an Axonius-internal (locally created) account. */
export function isInternalUser(user: AxoniusUser): boolean {
  const source = String(user.source ?? '').trim().toLowerCase()
  return source === '' || source === INTERNAL_SOURCE
}

// --- Body building --------------------------------------------------------

/** JSON:API create body for a user. Always requests an Axonius-generated password — never a supplied one. */
export function buildCreateBody(fields: {
  userName: string
  roleId: string
  email: string
  firstName: string
  lastName: string
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: CREATE_USER_SCHEMA_TYPE,
      attributes: {
        user_name: fields.userName,
        role_id: fields.roleId,
        auto_generated_password: true,
        email: fields.email,
        first_name: fields.firstName,
        last_name: fields.lastName,
      },
    },
  }
}

/**
 * JSON:API update body for a user (users_schema). Deliberately omits `password`
 * and `allowed_scopes_impersonation` (left to Axonius defaults) — this config
 * type never reads or writes password material.
 */
export function buildUpdateBody(fields: {
  userName: string
  roleId: string
  email: string
  firstName: string
  lastName: string
  title: string
  department: string
  ignoreRoleAssignmentRules: boolean
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: UPDATE_USER_SCHEMA_TYPE,
      attributes: {
        user_name: fields.userName,
        role_id: fields.roleId,
        email: fields.email,
        first_name: fields.firstName,
        last_name: fields.lastName,
        title: fields.title,
        department: fields.department,
        ignore_role_assignment_rules: fields.ignoreRoleAssignmentRules,
      },
    },
  }
}

/** JSON:API update body that restores a prior user snapshot verbatim (used by rollback). */
export function buildRestoreBody(attributes: Record<string, unknown>): { data: { type: string; attributes: Record<string, unknown> } } {
  return buildUpdateBody({
    userName: String(attributes.user_name ?? ''),
    roleId: String(attributes.role_id ?? ''),
    email: String(attributes.email ?? ''),
    firstName: String(attributes.first_name ?? ''),
    lastName: String(attributes.last_name ?? ''),
    title: String(attributes.title ?? ''),
    department: String(attributes.department ?? ''),
    ignoreRoleAssignmentRules: attributes.ignore_role_assignment_rules === true,
  })
}

/** JSON:API delete body — see the file header FLAG for why the type is "base_schema". */
export function buildDeleteBody(uuid: string): { data: { type: string; attributes: Record<string, unknown> } } {
  return { data: { type: DELETE_USER_SCHEMA_TYPE, attributes: { uuid } } }
}

// --- Response parsing ---------------------------------------------------------

/** Flatten a JSON:API `{ data: [ { id, attributes } ] }` list into users. */
export function usersFromResponse(json: unknown): AxoniusUser[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : []
  return rows.map((row) => {
    if (row && typeof row === 'object' && 'attributes' in (row as Record<string, unknown>)) {
      const r = row as { id?: string; attributes?: Record<string, unknown> }
      return { id: r.id, uuid: (r.attributes?.uuid as string) ?? r.id, ...(r.attributes ?? {}) } as AxoniusUser
    }
    return row as AxoniusUser
  })
}

/** The uuid of a user, from either its inline uuid or JSON:API id. */
export function userId(user: AxoniusUser | null | undefined): string | null {
  const id = user?.uuid ?? user?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * Find a live INTERNAL user by user_name — the stable identity we upsert on.
 * An LDAP/SAML/SSO-provisioned user with the same user_name is ignored, so this
 * config type never adopts or touches an externally-provisioned identity.
 */
export function findUser(list: AxoniusUser[], userName: string): AxoniusUser | null {
  const n = userName.trim()
  if (!n) return null
  return list.find((u) => String(u.user_name ?? '').trim() === n && isInternalUser(u)) ?? null
}
