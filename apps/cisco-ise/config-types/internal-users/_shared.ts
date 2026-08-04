// Shared helpers for the Internal Users config type (validate + deploy +
// rollback + drift). Field shapes verified against the community pyise-ers
// ERS client (add_user — github.com/falkowich/pyise-ers, pyiseers/pyiseers.py).
//
// `identityGroups` on the wire is a single comma-separated string of identity
// GROUP IDS (not names, not a JSON array) — this app resolves operator-facing
// group NAMEs to ids via the IdentityGroup resource client before sending it
// (see deploy.ts). `password` and `enablePassword` are WRITE-ONLY — see the
// canvas template's help text and deploy.ts's module doc.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { InternalUser } from '../../lib/iseApi'

export const MAX_USERNAME_LENGTH = 255
export const MAX_DESCRIPTION_LENGTH = 1000

export interface InternalUserSpec {
  username: string
  description: string
  firstName: string
  lastName: string
  email: string
  identityGroupNames: string[]
  /** '' = not provided this deploy. */
  password: string
  /** '' = not provided this deploy. */
  enablePassword: string
}

function readTagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

export function specFromItem(item: CanvasItemSnapshot): InternalUserSpec {
  return {
    username: String(item.fields.username ?? '').trim(),
    description: String(item.fields.description ?? '').trim(),
    firstName: String(item.fields.first_name ?? '').trim(),
    lastName: String(item.fields.last_name ?? '').trim(),
    email: String(item.fields.email ?? '').trim(),
    identityGroupNames: readTagList(item.fields.identity_groups),
    password: String(item.fields.password ?? '').trim(),
    enablePassword: String(item.fields.enable_password ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): InternalUserSpec[] {
  return items.map(specFromItem)
}

/**
 * The ERS create/update body. `identityGroupIds` is the ALREADY-RESOLVED
 * comma-separated id string (see deploy.ts) — omitted when there is no group
 * assignment. `password`/`enablePassword` are included ONLY when non-blank —
 * an absent value must never be conflated with "clear it" (ISE cannot echo
 * either back for us to compare in the first place).
 */
export function toInternalUserBody(spec: InternalUserSpec, identityGroupIds: string): Omit<InternalUser, 'id' | 'link'> {
  const body: Omit<InternalUser, 'id' | 'link'> = {
    name: spec.username,
    description: spec.description,
    firstName: spec.firstName,
    lastName: spec.lastName,
    email: spec.email,
  }
  if (identityGroupIds) body.identityGroups = identityGroupIds
  if (spec.password) body.password = spec.password
  if (spec.enablePassword) body.enablePassword = spec.enablePassword
  return body
}

/** Strip anything secret-shaped before a live user is persisted into rollbackData. */
export function stripSecrets(user: InternalUser): InternalUser {
  const { password, enablePassword, ...rest } = user
  void password
  void enablePassword
  return rest
}
