// Shared helpers for the Graylog Roles config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API (/api/roles):
//   • POST/PUT body  = RoleResponse { name, description?, permissions, read_only }
//   • GET  response  = RolesResponse { roles: [RoleResponse], total }
// Graylog ships built-in roles ("Admin", "Reader") with `read_only: true` —
// Graylog itself rejects updating or deleting them (RolesResource.java @ 6.1),
// so deploy/rollback check the live `read_only` flag and fail that item loudly
// rather than attempting (and being rejected by) the write.

import { asString } from '../../lib/coerce'

/** One role as returned by GET /api/roles (RoleResponse). */
export interface GraylogRole {
  name?: string
  description?: string
  permissions?: string[]
  read_only?: boolean
  [key: string]: unknown
}

/** GET /api/roles envelope: `{ roles: [...], total }`. */
interface RolesResponse {
  roles?: GraylogRole[]
  total?: number
}

/** Body sent to POST /api/roles and PUT /api/roles/{name}. */
export interface RoleBody {
  name: string
  description: string
  permissions: string[]
  read_only: boolean
}

export interface ParsedPermissions {
  permissions: string[]
  error?: string
}

/**
 * Parse the canvas `permissions` field: a JSON array of permission strings
 * (e.g. "streams:read", "*" for full admin). Blank is a valid empty set.
 */
export function parsePermissions(value: unknown): ParsedPermissions {
  if (value == null || value === '') return { permissions: [] }
  let raw: unknown = value
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return { permissions: [] }
    try {
      raw = JSON.parse(text)
    } catch (e) {
      return { permissions: [], error: `permissions is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }
  if (!Array.isArray(raw)) return { permissions: [], error: 'permissions must be a JSON array of permission strings' }
  return { permissions: raw.map((v) => String(v)) }
}

/** Unwrap GET /api/roles into a flat array of roles. */
export function rolesFromList(list: unknown): GraylogRole[] {
  if (Array.isArray(list)) return list as GraylogRole[]
  const roles = (list as RolesResponse | null)?.roles
  return Array.isArray(roles) ? roles : []
}

/** Find a live role by name (the stable identity used for upsert + drift). */
export function findRole(roles: GraylogRole[], name: string): GraylogRole | null {
  const n = asString(name)
  if (!n) return null
  return roles.find((r) => asString(r.name) === n) ?? null
}

/** Build the RoleResponse body from canvas fields. `read_only` is always false — this app never declares a read-only role. */
export function buildRoleBody(fields: Record<string, unknown>): { body?: RoleBody; error?: string } {
  const { permissions, error } = parsePermissions(fields.permissions)
  if (error) return { error }
  return {
    body: {
      name: asString(fields.name),
      description: asString(fields.description),
      permissions,
      read_only: false,
    },
  }
}

/** Build a restore body from a live role (rollback). */
export function bodyFromLiveRole(role: GraylogRole): RoleBody {
  return {
    name: asString(role.name),
    description: asString(role.description),
    permissions: Array.isArray(role.permissions) ? role.permissions : [],
    read_only: false,
  }
}
