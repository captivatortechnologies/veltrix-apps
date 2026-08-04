// Shared helpers for the TheHive Profiles (RBAC) config type (deploy + rollback + drift).
//
// Profile shapes follow the TheHive 5 API (InputProfile / InputUpdateProfile /
// OutputProfile at /api/v1/profile). TheHive 4 exposes the same create/update/
// delete/list surface, but on /api/v0/profile (CONFIRMED via the TheHive 4
// OpenAPI spec — see lib/thehiveApi.ts). Verify against a live TheHive.
//
// PERMISSION STRINGS: TheHive's permission catalog is version-dependent and not
// fully enumerated by any public client or doc — thehive4py's own test suite
// exercises examples like `manageCase` (whole-entity) and `manageAlert/create`
// (scoped action), so both bare and `entity/action` forms are valid. This app
// does NOT hardcode the catalog; read the exact set from your instance's
// Profiles → "Add or Remove Permissions" screen before authoring one here.
//
// DEFAULT PROFILES: TheHive ships six built-in profiles (admin, org-admin,
// analyst, read-only, and — v5.6+ — external-reader/external-actor). Only
// `analyst` is documented as editable/deletable; the other five are immutable.
// validate.ts warns (does not block) when a name matches one of the immutable
// ones, since TheHive itself will reject the write.

/** Built-in profile names documented as immutable (everything except `analyst`). */
export const IMMUTABLE_DEFAULT_PROFILES = ['admin', 'org-admin', 'read-only', 'external-reader', 'external-actor'] as const

/** A TheHive profile as authored (InputProfile) or returned (Output…). */
export interface Profile {
  // v5 returns `_id`; v4 returns `id`. Both are read via profileId().
  _id?: string
  id?: string | number
  name?: string
  permissions?: string[]
  editable?: boolean
  [key: string]: unknown
}

/** InputUpdateProfile (patch) — permissions only; name is omitted (see buildProfileUpdateBody). */
export interface ProfileUpdate {
  permissions: string[]
}

/** The stable id of a live profile (v5 `_id`, else v4 `id`), or null. */
export function profileId(p: Profile | null | undefined): string | null {
  if (!p) return null
  if (p._id != null && String(p._id).trim()) return String(p._id)
  if (p.id != null && String(p.id).trim()) return String(p.id)
  return null
}

/** Split a permissions textarea (newline and/or comma separated) into a deduped list. */
export function parsePermissions(value: unknown): string[] {
  const raw = String(value ?? '')
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\n,]/)) {
    const perm = part.trim()
    if (perm && !seen.has(perm)) {
      seen.add(perm)
      out.push(perm)
    }
  }
  return out
}

/** Find a live profile by name (the stable identity), case-sensitively (TheHive profile names are case-sensitive). */
export function findProfile(profiles: Profile[], name: string): Profile | null {
  const n = name.trim()
  if (!n) return null
  return profiles.find((p) => String(p.name ?? '').trim() === n) ?? null
}

/** Unwrap a list/query response into a flat array of profiles. */
export function profilesFromList(list: unknown): Profile[] {
  if (Array.isArray(list)) return list as Profile[]
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as Profile[]
  }
  return []
}

/** Build the InputProfile (create) body from canvas fields. */
export function buildProfileCreateBody(fields: Record<string, unknown>): { name: string; permissions: string[] } {
  return {
    name: String(fields.name ?? '').trim(),
    permissions: parsePermissions(fields.permissions),
  }
}

/**
 * Build the InputUpdateProfile (patch) body. `name` is deliberately omitted:
 * this config type upserts by name (the stable identity used for lookup/drift),
 * so a rename in the canvas is indistinguishable from creating a new profile —
 * same convention as the other config types in this app (users, custom fields).
 */
export function buildProfileUpdateBody(fields: Record<string, unknown>): ProfileUpdate {
  return { permissions: parsePermissions(fields.permissions) }
}

/** Map a live profile to the updatable subset (used by rollback restore). */
export function toProfileUpdate(p: Profile): ProfileUpdate {
  return { permissions: Array.isArray(p.permissions) ? p.permissions.map(String) : [] }
}
