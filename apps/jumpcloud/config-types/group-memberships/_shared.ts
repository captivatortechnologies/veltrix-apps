// Shared helpers for the JumpCloud User Group Memberships config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// This config type manages the USER MEMBERSHIP of an existing User Group as
// code. One canvas item declares one target group (by name) and the set of users
// that should belong to it.
//
// VERIFIED against the jcapi v2 model docs:
//   - List members:   GET  /usergroups/{id}/members  -> list[GraphConnection]
//                     (each connection has a `to` GraphObject carrying the id/type)
//   - Manage members: POST /usergroups/{id}/members  with UserGroupMembersReq
//                     { op: "add" | "remove", type: "user", id }
// FLAGGED — verify against a live JumpCloud tenant:
//   - The GraphConnection/GraphObject wire shape (this code reads `to.id`,
//     tolerating a flat `{ id }` as well).
//   - User resolution lists users over the JumpCloud v1 API
//     (GET /api/systemusers), whose response is a `{ results, totalCount }`
//     wrapper (verify the wrapper key + limit/skip paging).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** A 24-char hex JumpCloud ObjectId — a member entry that already IS an id. */
export const OBJECT_ID_RE = /^[a-f0-9]{24}$/i

/** One JumpCloud system user (v1 /systemusers list item). */
export interface JumpCloudSystemUser {
  _id?: string
  id?: string
  email?: string
  username?: string
  [key: string]: unknown
}

/** A member connection as returned by GET /usergroups/{id}/members. */
export interface GraphConnection {
  to?: { id?: string; type?: string; [key: string]: unknown }
  id?: string
  type?: string
  [key: string]: unknown
}

/** The desired membership for one User Group, extracted from a canvas item. */
export interface MembershipSpec {
  itemId?: string
  /** The User Group's name — the logical identity of the target group. */
  groupName: string
  /** Declared member identifiers: email, username, or a raw 24-hex user id. */
  members: string[]
  /**
   * When true this canvas OWNS the group's full membership — any live member not
   * declared here is removed. When false (default) membership is additive: only
   * declared members are added; existing extra members are left in place.
   */
  exclusive: boolean
}

/** Coerce a checkbox-ish value to a boolean (defaults false — additive membership). */
export function normalizeExclusive(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/** Split a members value (a tags array or a newline/comma string) into trimmed entries. */
export function toMemberList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const s = String(entry ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Each canvas item describes the membership of one JumpCloud User Group. */
export function extractMembershipSpecs(canvas: CanvasSnapshot): MembershipSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      groupName: String(fields.groupName ?? '').trim(),
      members: toMemberList(fields.members),
      exclusive: normalizeExclusive(fields.exclusive),
    }
  })
}

/** The user's JumpCloud object id (v1 uses `_id`; some responses expose `id`). */
export function userIdOf(user: JumpCloudSystemUser): string {
  return String(user.id ?? user._id ?? '')
}

export interface UserIndex {
  byEmail: Map<string, string>
  byUsername: Map<string, string>
  ids: Set<string>
}

/** Build lookup maps (email/username/id -> user id) from the org's system users. */
export function buildUserIndex(users: JumpCloudSystemUser[]): UserIndex {
  const byEmail = new Map<string, string>()
  const byUsername = new Map<string, string>()
  const ids = new Set<string>()
  for (const user of users) {
    const id = userIdOf(user)
    if (!id) continue
    ids.add(id)
    const email = String(user.email ?? '').trim().toLowerCase()
    const username = String(user.username ?? '').trim().toLowerCase()
    if (email) byEmail.set(email, id)
    if (username) byUsername.set(username, id)
  }
  return { byEmail, byUsername, ids }
}

/**
 * Resolve one declared member identifier to a JumpCloud user id:
 *   1. a 24-hex ObjectId is used directly (must exist in the org),
 *   2. otherwise match by email, then by username (case-insensitive).
 * Returns null when the user cannot be found.
 */
export function resolveMemberId(identifier: string, index: UserIndex): string | null {
  const raw = identifier.trim()
  if (!raw) return null
  if (OBJECT_ID_RE.test(raw)) return index.ids.has(raw) ? raw : null
  const key = raw.toLowerCase()
  return index.byEmail.get(key) ?? index.byUsername.get(key) ?? null
}

/** Extract the member user id from a GraphConnection (`to.id`, falling back to a flat `id`). */
export function memberIdOf(connection: GraphConnection): string {
  return String(connection.to?.id ?? connection.id ?? '')
}

export interface MemberDelta {
  toAdd: string[]
  toRemove: string[]
}

/**
 * Compute the add/remove operations to converge live membership on the desired
 * set. In exclusive mode, live members not in the desired set are removed;
 * otherwise membership is additive (nothing is removed).
 */
export function diffMembers(currentIds: Iterable<string>, desiredIds: Iterable<string>, exclusive: boolean): MemberDelta {
  const current = new Set(currentIds)
  const desired = new Set(desiredIds)
  const toAdd = [...desired].filter((id) => !current.has(id))
  const toRemove = exclusive ? [...current].filter((id) => !desired.has(id)) : []
  return { toAdd, toRemove }
}

/** Build one UserGroupMembersReq body for POST /usergroups/{id}/members. */
export function buildMemberOp(op: 'add' | 'remove', userId: string): Record<string, unknown> {
  return { op, type: 'user', id: userId }
}
