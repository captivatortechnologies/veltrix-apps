// Shared helpers for the Sumo Logic Users config type
// (deploy + rollback + drift + validate).
//
// A user is a flat record { id?, firstName, lastName, email, roleIds, isActive,
// isLocked, isMfaEnabled }. EMAIL is the stable identity used to upsert and is
// immutable after create — the update endpoint does not accept it (renaming a
// user's email is a dedicated flow: POST /users/{id}/email/requestChange,
// which requires the user to confirm via a link and is out of scope for
// declarative config). `isActive` cannot be set on CREATE — only on UPDATE —
// so a newly created user that should start deactivated needs a follow-up PUT.
// The list endpoint supports an `email=` query filter for an efficient direct
// lookup instead of paging through every user in the organization.
//   API: https://help.sumologic.com/docs/api/user-management/
//   Verified against the official Sumo Logic OpenAPI spec
//   (CreateUserDefinition / UpdateUserDefinition / UserModel,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic user. */
export interface SumoUser {
  id?: string
  firstName: string
  lastName: string
  email: string
  roleIds: string[]
  isActive?: boolean
  isLocked?: boolean
  isMfaEnabled?: boolean
  [key: string]: unknown
}

/** The { data: [...], next } envelope returned by GET /users. */
export interface UserList {
  data?: SumoUser[]
  next?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. Defaults to true (Active) when unset. */
export function normalizeActive(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  if (v === 'false' || v === '0' || v === 'no') return false
  return true
}

/** Split a canvas `tags` value into a trimmed, de-duplicated list of non-empty strings. */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => s(v)) : s(value).split(',').map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/** Unwrap the { data: [...] } list envelope into a flat array of users. */
export function usersFromList(list: unknown): SumoUser[] {
  if (Array.isArray(list)) return list as SumoUser[]
  const data = (list as UserList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live user by email (case-insensitive, trimmed) — the identity. */
export function findUserByEmail(users: SumoUser[], email: string): SumoUser | null {
  const n = email.trim().toLowerCase()
  if (!n) return null
  return users.find((u) => s(u.email).toLowerCase() === n) ?? null
}

/** Create-request body — the only place `email` is ever sent (immutable afterwards). */
export function buildUserCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    firstName: s(fields.firstName),
    lastName: s(fields.lastName),
    email: s(fields.email),
    roleIds: toStringList(fields.roleIds),
  }
}

/** Update-request body — everything mutable except `email`. `isActive` requires the manageUsersAndRoles capability to change for another user. */
export function buildUserUpdateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    firstName: s(fields.firstName),
    lastName: s(fields.lastName),
    isActive: normalizeActive(fields.isActive),
    roleIds: toStringList(fields.roleIds),
  }
}
