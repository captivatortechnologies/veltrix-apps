// =============================================================================
// Shared helpers for the Users config type (validate + deploy + rollback +
// drift). Field shapes verified against RESTAPI/Models/User.inc — see
// lib/pfsenseApi.ts's module doc for the `always_apply` (no apply-endpoint)
// and write-only-password citations.
//
// IDENTITY: `name` (StringField unique:true) — natural key, like aliases.
// System-scoped users (pfSense's own built-ins, e.g. "admin") are NEVER
// created, updated or deleted by this app — verified the Model itself
// forbids deleting them (`scope !== 'user'` check in `_delete()`); this app
// additionally never even attempts to touch a live user whose `scope` is
// not "user".
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { PfsenseUser } from '../../lib/pfsenseApi'

export const MAX_NAME_LENGTH = 32
export const MAX_DESCRIPTION_LENGTH = 1024

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

export interface UserSpec {
  itemId?: string
  name: string
  password: string
  disabled: boolean
  descr: string
  priv: string[]
  expires: string
  authorizedkeys: string
  ipsecpsk: string
}

export function specFromItem(item: CanvasItemSnapshot): UserSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id,
    name: String(f.name ?? '').trim(),
    password: String(f.password ?? ''),
    disabled: f.disabled === true,
    descr: String(f.descr ?? '').trim(),
    priv: strList(f.priv),
    expires: String(f.expires ?? '').trim(),
    authorizedkeys: String(f.authorizedkeys ?? '').trim(),
    ipsecpsk: String(f.ipsecpsk ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): UserSpec[] {
  return items.map(specFromItem)
}

/** Username identity — exact match, case-sensitive (matches the charset validator, which is case-preserving). */
export function userKey(name: string): string {
  return name.trim()
}

/** pfSense's own `m/d/Y` (MM/DD/YYYY) date format, verified against User.inc's DateTimeField. */
const EXPIRES_RE = /^(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}$/
export function isValidExpires(value: string): boolean {
  return value === '' || EXPIRES_RE.test(value)
}

/** The full create-request body for a spec. `password` is REQUIRED on create (verified). */
export function toUserCreateBody(spec: UserSpec): Omit<PfsenseUser, 'id'> {
  return {
    name: spec.name,
    password: spec.password,
    disabled: spec.disabled,
    descr: spec.descr,
    priv: spec.priv,
    expires: spec.expires,
    authorizedkeys: spec.authorizedkeys,
    ipsecpsk: spec.ipsecpsk,
  }
}

/**
 * The PATCH request body for a spec. `password` is OMITTED when blank in the
 * canvas — leaving the password field empty in the canvas means "don't
 * change the existing password" (this app never sends an empty-string
 * password to overwrite a real one). Set a new value to actually rotate it.
 */
export function toUserUpdateBody(spec: UserSpec): Omit<PfsenseUser, 'id'> {
  const body = toUserCreateBody(spec)
  if (!spec.password) delete body.password
  return body
}

/**
 * Snapshot a live user's managed fields for rollback. `password` is
 * intentionally OMITTED — see this file's module doc: it is treated
 * write-only in spirit, so rollback never attempts to "restore" a password
 * hash.
 */
export function snapshotUser(live: PfsenseUser): Omit<PfsenseUser, 'id' | 'password'> {
  return {
    name: live.name,
    disabled: live.disabled ?? false,
    descr: live.descr ?? '',
    priv: Array.isArray(live.priv) ? live.priv : [],
    expires: live.expires ?? '',
    authorizedkeys: live.authorizedkeys ?? '',
    ipsecpsk: live.ipsecpsk ?? '',
  }
}
