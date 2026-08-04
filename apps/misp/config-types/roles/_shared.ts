// Shared helpers for the MISP Roles config type (deploy + rollback + drift).
//
// MISP role shapes follow the 2.4 REST API (/roles/index, /admin/roles/add,
// /admin/roles/edit/{id}, /admin/roles/delete/{id}); verify against a live MISP
// 2.4 instance. Field set matches Role::generatePermFlags() plus the four
// legacy base permission columns (perm_add/modify/modify_org/publish) — the
// current, UI-exposed permission surface. `perm_full` is a legacy/unused DB
// column not surfaced by MISP's own role admin UI and is intentionally excluded.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/**
 * Every boolean permission flag this type manages, in the same grouping MISP's
 * own admin UI uses. Shared by canvas authoring, validate, deploy and drift so
 * the field list only needs to be declared once.
 */
export const PERM_FIELDS = [
  // Legacy base permissions (still real, settable role columns)
  'perm_add',
  'perm_modify',
  'perm_modify_org',
  'perm_publish',
  // Administration
  'perm_site_admin',
  'perm_admin',
  'perm_regexp_access',
  // Sync
  'perm_sync',
  'perm_sync_internal',
  'perm_sync_authoritative',
  'perm_auth',
  // Content & sharing
  'perm_tagger',
  'perm_tag_editor',
  'perm_template',
  'perm_sharing_group',
  'perm_delegate',
  'perm_sighting',
  'perm_object_template',
  'perm_galaxy_editor',
  'perm_decaying',
  'perm_warninglist',
  'perm_analyst_data',
  'perm_view_feed_correlations',
  // Publishing integrations
  'perm_publish_zmq',
  'perm_publish_kafka',
  'perm_server_sign',
  // Audit & misc
  'perm_audit',
  'perm_skip_otp',
] as const

export type PermField = (typeof PERM_FIELDS)[number]

/** One MISP role as returned inside a `{ Role: {...} }` envelope by /roles/index. */
export interface MispRole {
  id?: number | string
  name?: string
  default_role?: boolean | number | string
  restricted_to_site_admin?: boolean | number | string
  enforce_rate_limit?: boolean | number | string
  rate_limit_count?: number | string
  memory_limit?: string
  max_execution_time?: string
  [key: string]: unknown
}

/** Normalize a yes/no select (or a boolean / 1|0) to a boolean. */
export function normalizeYesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ Role: {...} }]` list into a flat array of roles. */
export function rolesFromList(list: unknown): MispRole[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'Role' in (row as Record<string, unknown>)
      ? ((row as { Role: MispRole }).Role)
      : (row as MispRole),
  )
}

/** Find a live role by name (case-insensitive — the stable identity). */
export function findRole(roles: MispRole[], name: string): MispRole | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return roles.find((r) => String(r.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Build the MISP role body from canvas fields (wrapped in `{ Role: {...} }` by callers). */
export function buildRoleFields(fields: Record<string, unknown>): MispRole {
  const body: MispRole = { name: String(fields.name ?? '').trim() }
  for (const perm of PERM_FIELDS) {
    body[perm] = normalizeYesNo(fields[perm])
  }
  body.default_role = normalizeYesNo(fields.default_role)
  body.restricted_to_site_admin = normalizeYesNo(fields.restricted_to_site_admin)
  body.enforce_rate_limit = normalizeYesNo(fields.enforce_rate_limit)
  body.rate_limit_count = Number(fields.rate_limit_count ?? 0)
  body.memory_limit = String(fields.memory_limit ?? '').trim()
  body.max_execution_time = String(fields.max_execution_time ?? '').trim()
  return body
}
