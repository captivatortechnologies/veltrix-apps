// Shared helpers for the Secret Server Users config type (deploy + rollback +
// drift + health). Shapes follow the Secret Server v1 REST API
// (/api/v1/users).
//
// VERIFIED against the Delinea/Thycotic PowerShell module source
// (thycotic-ps/thycotic.secretserver — New/Update/Search/Get-TssUser):
//   search  GET  /api/v1/users?filter.searchText=<text>&filter.includeInactive=true
//   read    GET  /api/v1/users/{id}
//   create  POST /api/v1/users        { userName, displayName, password, enabled, ... }
//   update  PUT  /api/v1/users/{id}   — the FULL user object
//
// PASSWORDS ARE OUT OF SCOPE, BY DESIGN. The create body REQUIRES a `password`
// — storing/rotating a local user's password as canvas config is a
// secret-handling anti-pattern this PAM app must not commit. This config type
// therefore reconciles PROFILE ATTRIBUTES for EXISTING users only
// (displayName, emailAddress, enabled, isApplicationAccount) and never
// creates a user or sends a password. A user that does not yet exist is a
// hard deploy failure with a clear message — create it in Secret Server
// (local) or via Active Directory sync first.
//
// A user backed by a domain (AD) sync is also skipped — like a synchronized
// group, its profile is owned by the directory, not Secret Server. UNVERIFIED
// convention: a `domainId` present and > 0 is treated as directory-managed
// (mirroring the -1 "root"/"local" sentinel folders use for parentFolderId);
// verify against a live instance.
//
// Update-TssUser PUTs the user's FULL object (not a partial patch), so deploy
// fetches the live user first, overlays only the managed fields, and PUTs the
// merged object back — every field this app does not manage passes through
// unchanged.

import { normalizeBool, type SecretServerClient, listAllRecords } from '../../lib/secretServerApi'

/** One user as returned by GET /api/v1/users/{id} or the search records. */
export interface LiveUser {
  id?: number | string
  userName?: string
  displayName?: string
  emailAddress?: string
  enabled?: boolean
  isApplicationAccount?: boolean
  domainId?: number | string
  domainName?: string
  [key: string]: unknown
}

/** One user's managed profile attributes, declared by a canvas item. */
export interface UserSpec {
  username: string
  displayName: string
  emailAddress: string
  enabled: boolean
  isApplicationAccount: boolean
  comment: string
}

/** A canvas item shape (id/name optional; only fields are read). */
export interface CanvasItemLike {
  fields: Record<string, unknown>
}

export function usernameOf(u: LiveUser): string {
  return String(u.userName ?? '')
}

/** A live user's numeric id, or null when absent / non-numeric. */
export function userIdOf(u: LiveUser): number | null {
  const raw = u.id
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * A user backed by Active Directory — its profile is owned by the directory,
 * not Secret Server, so this app must not overwrite it (mirrors the
 * `isSynchronizedGroup` guard on the Groups config type). UNVERIFIED sentinel:
 * treats a positive `domainId` as directory-managed; verify against a live
 * instance.
 */
export function isDirectoryUser(u: LiveUser): boolean {
  const raw = u.domainId
  if (raw === undefined || raw === null || raw === '') return false
  const n = Number(raw)
  return Number.isFinite(n) && n > 0
}

/** Map canvas items to user specs. */
export function extractUserSpecs(items: CanvasItemLike[]): UserSpec[] {
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      username: String(f.username ?? '').trim(),
      displayName: String(f.displayName ?? '').trim(),
      emailAddress: String(f.emailAddress ?? '').trim(),
      enabled: normalizeBool(f.enabled),
      isApplicationAccount: normalizeBool(f.isApplicationAccount),
      comment: String(f.comment ?? '').trim(),
    }
  })
}

/**
 * Search users, filtered by a partial text match against the username,
 * across every page. `filter.includeInactive=true` so a disabled user is
 * still matched. Throws on a non-OK response.
 */
export async function searchUsers(client: SecretServerClient, searchText: string): Promise<LiveUser[]> {
  return listAllRecords<LiveUser>(client, '/users', { 'filter.searchText': searchText, 'filter.includeInactive': true })
}

/** Find a live user by exact username (case-insensitive) — search is a partial match, so callers must narrow. */
export function findUserByUsername(users: LiveUser[], username: string): LiveUser | null {
  const n = username.trim().toLowerCase()
  if (!n) return null
  return users.find((u) => usernameOf(u).trim().toLowerCase() === n) ?? null
}

/**
 * Merge the managed fields from `spec` onto the FULL live user object,
 * preserving every field this app does not manage — the body PUT
 * /api/v1/users/{id} expects.
 */
export function buildUserUpdateBody(spec: UserSpec, existing: LiveUser): Record<string, unknown> {
  return {
    ...existing,
    displayName: spec.displayName,
    emailAddress: spec.emailAddress,
    enabled: spec.enabled,
    isApplicationAccount: spec.isApplicationAccount,
  }
}

/** Restore body for a prior user — the exact full object snapshotted before deploy. */
export function buildUserRestoreBody(prior: LiveUser): Record<string, unknown> {
  return { ...prior }
}
