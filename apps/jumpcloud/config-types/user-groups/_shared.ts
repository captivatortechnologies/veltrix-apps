// Shared helpers for the JumpCloud User Groups config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// User Group shapes follow the JumpCloud API v2 (/usergroups). The POST/PUT body
// fields beyond `name` (description, email, membershipMethod) should be verified
// against a live JumpCloud — the public jcapi model markdown enumerates only
// `name` + `attributes`, while JumpCloud's own docs describe the wider object.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/**
 * Membership methods this config type offers. JumpCloud also supports
 * DYNAMIC_REVIEW_REQUIRED, which is intentionally out of scope for v0.1.0 (it
 * needs a member query + a manual review step this canvas does not author).
 */
export const MEMBERSHIP_METHODS = ['STATIC', 'DYNAMIC_AUTOMATED'] as const
export type MembershipMethod = (typeof MEMBERSHIP_METHODS)[number]
export const MEMBERSHIP_METHOD_SET: ReadonlySet<string> = new Set(MEMBERSHIP_METHODS)

/** Loose email shape check — a full RFC validation is neither needed nor wanted here. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** One JumpCloud User Group as returned by GET /usergroups and GET /usergroups/{id}. */
export interface JumpCloudUserGroup {
  id?: string
  name?: string
  description?: string
  email?: string
  /** Always "user_group" for this endpoint. */
  type?: string
  membershipMethod?: string
  [key: string]: unknown
}

/** The desired state for one User Group, extracted from a canvas item. */
export interface UserGroupSpec {
  /** Stable canvas item id — survives renames; used to match a live group by the
   *  external id stored from the prior deploy (rename-safe identity). */
  itemId?: string
  /** Group name — the logical identity live groups are matched on. */
  name: string
  description: string
  email: string
  membershipMethod: MembershipMethod
}

/** Coerce a raw membership-method value to a supported enum (defaults to STATIC). */
export function normalizeMembershipMethod(value: unknown): MembershipMethod {
  const method = String(value ?? '').trim().toUpperCase()
  return MEMBERSHIP_METHOD_SET.has(method) ? (method as MembershipMethod) : 'STATIC'
}

/** Each canvas item describes one JumpCloud User Group. */
export function extractUserGroupSpecs(canvas: CanvasSnapshot): UserGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
      email: String(fields.email ?? '').trim(),
      membershipMethod: normalizeMembershipMethod(fields.membershipMethod),
    }
  })
}

/** Find a live User Group by name (case-insensitive — the stable identity). */
export function findUserGroupByName(
  groups: JumpCloudUserGroup[],
  name: string,
): JumpCloudUserGroup | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === target) ?? null
}

/**
 * Build the JumpCloud User Group body for POST/PUT /usergroups.
 * `name` is always sent. `description` is always sent (empty string clears it) so
 * a PUT converges the live group and drift agrees about the target state. `email`
 * is sent only when set (JumpCloud rejects a malformed / empty email). The
 * membership method is always sent (defaults STATIC).
 */
export function buildUserGroupBody(spec: UserGroupSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    membershipMethod: spec.membershipMethod,
  }
  if (spec.email) body.email = spec.email
  return body
}

/** The subset of a live group's fields this config type manages — captured for rollback. */
export function priorFieldsOf(group: JumpCloudUserGroup): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: String(group.name ?? ''),
    description: String(group.description ?? ''),
    membershipMethod: normalizeMembershipMethod(group.membershipMethod),
  }
  if (group.email) body.email = String(group.email)
  return body
}
