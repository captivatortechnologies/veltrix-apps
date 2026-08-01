// Shared helpers for the TheHive Users config type (deploy + rollback + drift).
//
// User shapes follow the TheHive 5 API (InputUser / InputUpdateUser / OutputUser
// at /api/v1/user). TheHive 4 uses the same field names at /api/user. Verify
// against a live TheHive (see README, v4 vs v5).
//
// SCOPE: this config type manages a user's identity and access within the
// organisation the API key belongs to — login (identity), display name, profile
// (role) and organisation. It deliberately does NOT manage passwords or API keys
// (credential material must not live in canvas config); provision those out of
// band. Multi-organisation membership (PUT /user/{id}/organisations) is out of
// scope — the single `organisation`/`profile` pair covers the common case.

/** A TheHive user as authored (InputUser) or returned (OutputUser). */
export interface HiveUser {
  // v5 returns `_id`; v4 returns `id`. Both are read via userId().
  _id?: string
  id?: string | number
  login?: string
  name?: string
  email?: string
  profile?: string
  organisation?: string
  locked?: boolean
  type?: string
  [key: string]: unknown
}

/** InputUser (create) — login/name/profile required; email/organisation optional. */
export interface UserCreate {
  login: string
  name: string
  profile: string
  email?: string
  organisation?: string
}

/** InputUpdateUser (patch) — the mutable subset; login is immutable so it is omitted. */
export interface UserUpdate {
  name?: string
  profile?: string
  organisation?: string
  email?: string
}

/** The stable id of a live user (v5 `_id`, else v4 `id`), or null. */
export function userId(u: HiveUser | null | undefined): string | null {
  if (!u) return null
  if (u._id != null && String(u._id).trim()) return String(u._id)
  if (u.id != null && String(u.id).trim()) return String(u.id)
  return null
}

/** Normalise a login for identity comparison — TheHive lower-cases logins. */
export function normalizeLogin(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Find a live user by login (the stable identity), case-insensitively. */
export function findUser(users: HiveUser[], login: string): HiveUser | null {
  const l = normalizeLogin(login)
  if (!l) return null
  return users.find((u) => normalizeLogin(u.login) === l) ?? null
}

/** Unwrap a list/query response into a flat array of users. */
export function usersFromList(list: unknown): HiveUser[] {
  if (Array.isArray(list)) return list as HiveUser[]
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as HiveUser[]
  }
  return []
}

/** Build the InputUser (create) body from canvas fields. */
export function buildUserCreateBody(fields: Record<string, unknown>): UserCreate {
  const body: UserCreate = {
    login: normalizeLogin(fields.login),
    name: String(fields.name ?? '').trim(),
    profile: String(fields.profile ?? '').trim(),
  }
  const email = String(fields.email ?? '').trim()
  const organisation = String(fields.organisation ?? '').trim()
  if (email) body.email = email
  if (organisation) body.organisation = organisation
  return body
}

/** Build the InputUpdateUser (patch) body — mutable fields present in canvas. */
export function buildUserUpdateBody(fields: Record<string, unknown>): UserUpdate {
  const body: UserUpdate = {
    name: String(fields.name ?? '').trim(),
    profile: String(fields.profile ?? '').trim(),
  }
  const email = String(fields.email ?? '').trim()
  const organisation = String(fields.organisation ?? '').trim()
  if (email) body.email = email
  if (organisation) body.organisation = organisation
  return body
}

/** Map a live user to the updatable subset (used by rollback restore). */
export function toUserUpdate(u: HiveUser): UserUpdate {
  const body: UserUpdate = {}
  if (u.name != null) body.name = String(u.name)
  if (u.profile != null) body.profile = String(u.profile)
  if (u.organisation != null) body.organisation = String(u.organisation)
  if (u.email != null) body.email = String(u.email)
  return body
}
