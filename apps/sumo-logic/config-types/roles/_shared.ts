// Shared helpers for the Sumo Logic Roles config type
// (deploy + rollback + drift + validate).
//
// A role is a flat record { id?, name, description?, filterPredicate?,
// capabilities[], users[] }. The list endpoint returns them inside a
// { data: [...], next } envelope and pages via a `?token=` query parameter.
//   API: https://www.sumologic.com/help/docs/api/role-management-v2/
//   Endpoints/shapes verified against the SumoLogic terraform provider model
//   (sumologic/sumologic_role.go): create POST v1/roles, get/update/delete
//   v1/roles/{id}, list GET v1/roles → { data, next }. capabilities/users are
//   []string.

/** One Sumo Logic RBAC role. */
export interface Role {
  id?: string
  /** Role name — the stable identity used to upsert. */
  name: string
  description?: string
  /** Search filter limiting which logs the role can see, e.g. _sourceCategory=prod/*. */
  filterPredicate?: string
  /** Capability names granted to the role. */
  capabilities?: string[]
  /** User ids assigned to the role (left untouched by this config type). */
  users?: string[]
  [key: string]: unknown
}

/** The { data: [...], next } envelope returned by GET /roles. */
export interface RoleList {
  data?: Role[]
  next?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Coerce a canvas `tags`/`multiselect` value (array) — or a comma-separated
 * string fallback — into a trimmed, de-duplicated list of non-empty strings.
 */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => s(v))
    : s(value)
        .split(',')
        .map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) {
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

/** Unwrap the { data: [...] } list envelope into a flat array of roles. */
export function rolesFromList(list: unknown): Role[] {
  if (Array.isArray(list)) return list as Role[]
  const data = (list as RoleList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live role by name (case-insensitive, trimmed) — the role identity. */
export function findRole(roles: Role[], name: string): Role | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return roles.find((r) => s(r.name).toLowerCase() === n) ?? null
}

/**
 * Build the role request body from canvas fields. `name` is included (Sumo Logic
 * requires it on both create and update); `id` is intentionally omitted (it lives
 * in the path on update). `users` is not managed by this config type, so it is
 * left off the body — membership stays as-is in Sumo Logic.
 */
export function buildRoleBody(fields: Record<string, unknown>): Role {
  const body: Role = {
    name: s(fields.name),
    capabilities: toStringList(fields.capabilities),
  }
  body.description = s(fields.description)
  body.filterPredicate = s(fields.filterPredicate)
  return body
}
