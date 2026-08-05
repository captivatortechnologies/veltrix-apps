// =============================================================================
// Shared "policy target" (from/to) shape for the Mimecast Policy Management v1
// REST API (/policy-management/cloud-gateway/v1/*). Anti-Spoofing, Greylisting,
// Delivery Route policies and DNS Authentication - Outbound policies all embed
// this same target object for scoping which mail a policy applies to.
//
// The live API also allows a `profile_group` target (referencing a directory
// group's secure id — this app already manages those groups declaratively as
// the `directory-groups` config type, so referencing one by id here mirrors how
// address-alteration already references an address-alteration-set by id) and an
// `address_attribute_value` target (matching a custom directory attribute).
// address_attribute_value is intentionally NOT modeled — it requires knowing an
// account-specific attribute id with no config type in this app to look one up
// against, and no live picker exists for it; every other target type is a
// self-contained value (a domain, an email address, a group id) requiring no
// additional lookup.
// =============================================================================

import type { ValidationResult } from '@veltrixsecops/app-sdk'

export const TARGET_TYPES_V1 = [
  'everyone',
  'internal_addresses',
  'external_addresses',
  'email_domain',
  'profile_group',
  'individual_email_address',
] as const

export interface PolicyTargetV1 {
  type?: string
  domain?: string
  emailAddress?: string
  groupId?: string
}

export function buildTargetV1(type: string, value: string): PolicyTargetV1 {
  if (type === 'email_domain') return { type, domain: value }
  if (type === 'individual_email_address') return { type, emailAddress: value }
  if (type === 'profile_group') return { type, groupId: value }
  return { type: type || 'everyone' }
}

/** A stable comparison key for a policy target (declared or live). */
export function targetValueV1(t?: PolicyTargetV1): string {
  if (!t) return 'everyone'
  if (t.type === 'email_domain') return `email_domain:${(t.domain ?? '').toLowerCase()}`
  if (t.type === 'individual_email_address') return `individual_email_address:${(t.emailAddress ?? '').toLowerCase()}`
  if (t.type === 'profile_group') return `profile_group:${(t.groupId ?? '').toLowerCase()}`
  return t.type || 'everyone'
}

export function validateTargetV1(
  type: string,
  value: string,
  side: string,
  prefix: string,
  errors: ValidationResult['errors']
): void {
  if (!(TARGET_TYPES_V1 as readonly string[]).includes(type)) {
    errors.push({ field: `${prefix}.${side}Type`, message: `${side} type must be one of: ${TARGET_TYPES_V1.join(', ')}`, code: 'invalid_target_type' })
    return
  }
  if (type === 'email_domain' || type === 'individual_email_address' || type === 'profile_group') {
    if (!value) {
      const label = type === 'email_domain' ? 'a domain' : type === 'individual_email_address' ? 'an email address' : "the directory group's secure id"
      errors.push({ field: `${prefix}.${side}Value`, message: `${side} needs ${label}`, code: 'missing_value' })
    }
  }
}

/** Parse a textarea/list field (newline- or comma-separated) into a de-blanked string[]. */
export function parseListV1(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string')
    return v
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  return []
}

/** Normalize a string[] for stable, order-independent comparison. */
export function normListV1(list?: string[]): string {
  return (list ?? [])
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',')
}
