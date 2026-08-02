// Shared helpers for the Auth0 Roles (RBAC) config type (deploy + rollback + drift).
//
// Roles are RBAC roles — GET/POST /api/v2/roles and GET/PATCH/DELETE /api/v2/roles/{id}.
// The Management API keys a role on the server-assigned `id`, so this config type
// upserts by role NAME. A role's permissions are managed through a sub-resource:
//   GET    /api/v2/roles/{id}/permissions   list permissions
//   POST   /api/v2/roles/{id}/permissions   associate permissions
//   DELETE /api/v2/roles/{id}/permissions   remove permissions
// each taking a { permissions: [{ resource_server_identifier, permission_name }] } body.
//
// Permissions are authored in a textarea, one per line as
// `<resource-server-identifier>|<permission-name>` (a space also separates them).
//
// Verified against the official Auth0 Management API v2 (Roles):
//   https://auth0.com/docs/api/management/v2/roles/post-roles
//   https://auth0.com/docs/api/management/v2/roles/post-role-permission-assignment

import { readOptionalString, readString } from '../../lib/fields'

/** One role as returned by the Management API. */
export interface Auth0Role {
  id?: string
  name?: string
  description?: string
  [key: string]: unknown
}

/** One permission grant on a role (an API identifier + a scope name). */
export interface Auth0Permission {
  resource_server_identifier?: string
  permission_name?: string
}

/** The managed role body sent to POST/PATCH (name is the identity; description optional). */
export interface RoleBody {
  name: string
  description?: string
}

/** Find a live role by name (case-sensitive, trimmed) — the upsert identity. */
export function findRoleByName(roles: Auth0Role[], name: string): Auth0Role | null {
  const n = name.trim()
  if (!n) return null
  return roles.find((r) => String(r.name ?? '').trim() === n) ?? null
}

/** Build the role body from canvas fields. */
export function buildRoleBody(fields: Record<string, unknown>): RoleBody {
  const body: RoleBody = { name: readString(fields.name) }
  const description = readOptionalString(fields.description)
  if (description !== undefined) body.description = description
  return body
}

/**
 * Stable key for a permission grant — identity is the (API identifier, permission
 * name) tuple, serialized as JSON so the two tokens can never collide regardless
 * of their contents.
 */
export function permKey(p: Auth0Permission): string {
  return JSON.stringify([
    String(p.resource_server_identifier ?? '').trim(),
    String(p.permission_name ?? '').trim(),
  ])
}

/**
 * Parse the permissions textarea into a de-duplicated list of grants. Each line is
 * `<resource-server-identifier>|<permission-name>`; when there is no pipe, the line
 * is split on its first run of whitespace. Lines that do not yield two non-empty
 * tokens are dropped (validate.ts reports them).
 */
export function parsePermissions(value: unknown): Auth0Permission[] {
  const lines = typeof value === 'string' ? value.split(/[\r\n]+/) : Array.isArray(value) ? value.map((v) => String(v ?? '')) : []
  const out: Auth0Permission[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    const parsed = parsePermissionLine(line)
    if (!parsed) continue
    const key = permKey(parsed)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(parsed)
    }
  }
  return out
}

/** Parse one permission line to a grant, or null when it is blank / malformed. */
export function parsePermissionLine(line: string): Auth0Permission | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let identifier: string
  let name: string
  const pipe = trimmed.indexOf('|')
  if (pipe >= 0) {
    identifier = trimmed.slice(0, pipe).trim()
    name = trimmed.slice(pipe + 1).trim()
  } else {
    const m = /^(\S+)\s+(\S.*)$/.exec(trimmed)
    if (!m) return null
    identifier = m[1].trim()
    name = m[2].trim()
  }
  if (!identifier || !name) return null
  return { resource_server_identifier: identifier, permission_name: name }
}

/** Normalize a live permissions list to the managed grant shape. */
export function normalizePermissions(list: Auth0Permission[] | undefined): Auth0Permission[] {
  const out: Auth0Permission[] = []
  const seen = new Set<string>()
  for (const p of list ?? []) {
    const grant: Auth0Permission = {
      resource_server_identifier: String(p?.resource_server_identifier ?? '').trim(),
      permission_name: String(p?.permission_name ?? '').trim(),
    }
    if (!grant.resource_server_identifier || !grant.permission_name) continue
    const key = permKey(grant)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(grant)
    }
  }
  return out
}

/** Compute the permission grants to add and to remove to reach `desired` from `current`. */
export function diffPermissions(
  desired: Auth0Permission[],
  current: Auth0Permission[],
): { toAdd: Auth0Permission[]; toRemove: Auth0Permission[] } {
  const desiredKeys = new Set(desired.map(permKey))
  const currentKeys = new Set(current.map(permKey))
  return {
    toAdd: desired.filter((p) => !currentKeys.has(permKey(p))),
    toRemove: current.filter((p) => !desiredKeys.has(permKey(p))),
  }
}

/** Two permission sets are equal (order-insensitive). */
export function samePermissions(a: Auth0Permission[], b: Auth0Permission[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b.map(permKey))
  return a.every((p) => setB.has(permKey(p)))
}
