// Shared helpers for the Axonius Roles config type (deploy + rollback + drift +
// validate). A role is a named permission set (a nested category → action
// dict, tenant/version-specific) plus an optional data-scope restriction.
// Shapes follow the axonius-api-client JSON:API surface; verify against a live
// Axonius tenant.
//
// Endpoints (verified against axonius_api_client master — api_endpoints.py,
// json_api/system_roles.py):
//   GET    api/settings/roles         list roles (type_ roles_details_schema)
//   POST   api/settings/roles         create (type_ roles_schema)
//   PUT    api/settings/roles/{uuid}  update (type_ roles_schema, no uuid in body)
//   DELETE api/settings/roles/{uuid}  delete — request_as_none: no request body at all

/** JSON:API resource type shared by the create/update body (roles_schema). */
const ROLE_SCHEMA_TYPE = 'roles_schema'

// --- Endpoint resource paths (relative to the API root, e.g. `api/`) ----------

/** GET — list every role (no pagination on this endpoint). */
export const ROLES_LIST_RESOURCE = 'settings/roles'
/** POST — create a role. */
export const CREATE_ROLE_RESOURCE = 'settings/roles'
/** PUT — update a role by uuid. */
export function updateRoleResource(uuid: string): string {
  return `settings/roles/${encodeURIComponent(uuid)}`
}
/** DELETE — remove a role by uuid (no request body — verified request_as_none). */
export function deleteRoleResource(uuid: string): string {
  return `settings/roles/${encodeURIComponent(uuid)}`
}

// --- Types --------------------------------------------------------------------

/** The `data_scope_restriction` object on a role ({ enabled, data_scope: uuid|null }). */
export interface DataScopeRestriction {
  enabled: boolean
  data_scope: string | null
}

/** One role, flattened from a JSON:API `{ id, attributes }` row. */
export interface AxoniusRole {
  id?: string
  uuid?: string
  name?: string
  permissions?: Record<string, unknown>
  data_scope_restriction?: DataScopeRestriction
  predefined?: boolean
  users_count?: number
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

/**
 * Parse a JSON object from a canvas value (the role's `permissions` — a
 * tenant/version-specific nested category → action dict, not independently
 * schema-checked here). An empty value yields an empty object.
 */
export function parsePermissions(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

// --- Body building --------------------------------------------------------

/** Build the `data_scope_restriction` object (verified `build_data_scope_restriction`). */
export function buildDataScopeRestriction(enabled: boolean, dataScopeUuid: string | null): DataScopeRestriction {
  return { enabled, data_scope: enabled ? dataScopeUuid : null }
}

/** JSON:API create/update body for a role (roles_schema; no uuid — carried in the URL only). */
export function buildRoleBody(fields: {
  name: string
  permissions: Record<string, unknown>
  dataScopeRestriction: DataScopeRestriction
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: ROLE_SCHEMA_TYPE,
      attributes: {
        name: fields.name,
        permissions: fields.permissions,
        data_scope_restriction: fields.dataScopeRestriction,
      },
    },
  }
}

/** JSON:API update body that restores a prior role snapshot verbatim (used by rollback). */
export function buildRestoreBody(attributes: Record<string, unknown>): { data: { type: string; attributes: Record<string, unknown> } } {
  return buildRoleBody({
    name: String(attributes.name ?? ''),
    permissions: (attributes.permissions as Record<string, unknown>) ?? {},
    dataScopeRestriction: (attributes.data_scope_restriction as DataScopeRestriction) ?? { enabled: false, data_scope: null },
  })
}

// --- Response parsing ---------------------------------------------------------

/** Flatten a JSON:API `{ data: [ { id, attributes } ] }` list into roles. */
export function rolesFromResponse(json: unknown): AxoniusRole[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : []
  return rows.map((row) => {
    if (row && typeof row === 'object' && 'attributes' in (row as Record<string, unknown>)) {
      const r = row as { id?: string; attributes?: Record<string, unknown> }
      return { id: r.id, uuid: (r.attributes?.uuid as string) ?? r.id, ...(r.attributes ?? {}) } as AxoniusRole
    }
    return row as AxoniusRole
  })
}

/** The uuid of a role, from either its inline uuid or JSON:API id. */
export function roleId(role: AxoniusRole | null | undefined): string | null {
  const id = role?.uuid ?? role?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * Find a live role by name — the stable identity we upsert on. A predefined
 * (built-in — Admin, Restricted, Viewer, ...) role with the same name is
 * ignored so we never try to adopt/overwrite an Axonius built-in; if a canvas
 * item collides with a predefined role's name, Axonius's own uniqueness check
 * surfaces a clear create error instead.
 */
export function findRole(list: AxoniusRole[], name: string): AxoniusRole | null {
  const n = name.trim()
  if (!n) return null
  return list.find((r) => String(r.name ?? '').trim() === n && r.predefined !== true) ?? null
}

/** Find a role by name, INCLUDING predefined ones — used to resolve `role_name` → `role_id` for the users config type. */
export function findRoleByName(list: AxoniusRole[], name: string): AxoniusRole | null {
  const n = name.trim()
  if (!n) return null
  return list.find((r) => String(r.name ?? '').trim() === n) ?? null
}
