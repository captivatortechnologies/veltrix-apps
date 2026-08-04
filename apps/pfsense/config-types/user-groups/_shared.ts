// =============================================================================
// Shared helpers for the User Groups config type (validate + deploy +
// rollback + drift). Field shapes verified against
// RESTAPI/Models/UserGroup.inc — see lib/pfsenseApi.ts's module doc for the
// `always_apply` (no apply-endpoint) citation.
//
// IDENTITY: `name` (StringField unique:true) — natural key, like aliases.
// `scope: "system"` groups (pfSense's own built-ins, e.g. "admins",
// "all") are NEVER created, updated or deleted by this app — verified the
// Model itself forbids creating/deleting them; this app additionally never
// even attempts to touch a live group whose `scope` is "system".
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { PfsenseUserGroup } from '../../lib/pfsenseApi'

export const MAX_NAME_LENGTH = 64
/** `name` must be <=16 chars when `scope` is "local" (verified: UserGroup::validate_name()) — this app always creates `local`-scope groups. */
export const MAX_LOCAL_NAME_LENGTH = 16

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

export interface UserGroupSpec {
  itemId?: string
  name: string
  description: string
  member: string[]
  priv: string[]
}

export function specFromItem(item: CanvasItemSnapshot): UserGroupSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id,
    name: String(f.name ?? '').trim(),
    description: String(f.description ?? '').trim(),
    member: strList(f.member),
    priv: strList(f.priv),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): UserGroupSpec[] {
  return items.map(specFromItem)
}

/** Group-name identity — exact match, case-sensitive (matches the charset validator, which is case-preserving). */
export function groupKey(name: string): string {
  return name.trim()
}

export function toUserGroupBody(spec: UserGroupSpec): Omit<PfsenseUserGroup, 'id'> {
  return { name: spec.name, description: spec.description, member: spec.member, priv: spec.priv }
}

export function snapshotUserGroup(live: PfsenseUserGroup): Omit<PfsenseUserGroup, 'id'> {
  return {
    name: live.name,
    description: live.description ?? '',
    member: Array.isArray(live.member) ? live.member : [],
    priv: Array.isArray(live.priv) ? live.priv : [],
  }
}
