import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parsePositiveInt } from '../../lib/cyberark'

// =============================================================================
// CyberArk Safe Members — validate + shared spec extraction.
//
// A safe member grants a User / Group / Role a set of authorizations on a safe.
// Identity is the (safe name, member name) pair. In the Gen2 API the granted
// authorizations are a FLAT object of booleans; the canvas models them as a
// multiselect of permission keys, and deploy expands the selection into the full
// boolean object (unselected keys = false).
// =============================================================================

/** The 22 Gen2 safe-member permission keys, in the API's documented order. */
export const SAFE_MEMBER_PERMISSIONS = [
  'useAccounts',
  'retrieveAccounts',
  'listAccounts',
  'addAccounts',
  'updateAccountContent',
  'updateAccountProperties',
  'initiateCPMAccountManagementOperations',
  'specifyNextAccountContent',
  'renameAccounts',
  'deleteAccounts',
  'unlockAccounts',
  'manageSafe',
  'manageSafeMembers',
  'backupSafe',
  'viewAuditLog',
  'viewSafeMembers',
  'accessWithoutConfirmation',
  'createFolders',
  'deleteFolders',
  'moveAccountsAndFolders',
  'requestsAuthorizationLevel1',
  'requestsAuthorizationLevel2',
] as const
export type SafeMemberPermission = (typeof SAFE_MEMBER_PERMISSIONS)[number]

const PERMISSION_SET = new Set<string>(SAFE_MEMBER_PERMISSIONS)

/** Member types recognised by the Vault. */
export const MEMBER_TYPES = ['User', 'Group', 'Role'] as const
export type MemberType = (typeof MEMBER_TYPES)[number]

const MEMBER_TYPE_SET = new Set<string>(MEMBER_TYPES)

export interface SafeMemberSpec {
  sectionName: string
  safeName: string
  memberName: string
  /** Raw member type — validated against MEMBER_TYPES (deploy runs post-validate). */
  memberType: string
  searchIn: string
  /** Unix epoch seconds, or null for "never expires". */
  membershipExpiration: number | null
  /** Selected permission keys (a subset of SAFE_MEMBER_PERMISSIONS). */
  permissions: string[]
}

/** Shape of a member returned by GET /Safes/{safeUrlId}/Members. */
export interface LiveSafeMember {
  memberName?: string
  memberType?: string
  membershipExpirationDate?: number | null
  permissions?: Record<string, boolean>
}

/** The (safeName, memberName) natural key — a safe member's identity. */
export function memberKey(spec: { safeName: string; memberName: string }): string {
  return JSON.stringify([spec.safeName.trim().toLowerCase(), spec.memberName.trim().toLowerCase()])
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
  if (typeof value === 'string' && value.trim()) return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

/** Each canvas item describes one safe member. */
export function extractSafeMemberSpecs(canvas: CanvasSnapshot): SafeMemberSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    // Preserve the raw value (blank → default "User") so validate can reject an
    // unrecognised type rather than silently coercing it.
    const memberType = typeof fields.member_type === 'string' && fields.member_type.trim() ? fields.member_type.trim() : 'User'
    return {
      sectionName: section.name,
      safeName: typeof fields.safe_name === 'string' ? fields.safe_name.trim() : '',
      memberName: typeof fields.member_name === 'string' ? fields.member_name.trim() : '',
      memberType,
      searchIn: typeof fields.search_in === 'string' && fields.search_in.trim() ? fields.search_in.trim() : 'Vault',
      membershipExpiration: parsePositiveInt(fields.membership_expiration).value,
      permissions: readStringList(fields.permissions).filter((p) => PERMISSION_SET.has(p)),
    }
  })
}

/** Expand a selection into the full flat boolean permission object the API wants. */
export function buildPermissionObject(selected: string[]): Record<string, boolean> {
  const chosen = new Set(selected)
  const out: Record<string, boolean> = {}
  for (const key of SAFE_MEMBER_PERMISSIONS) out[key] = chosen.has(key)
  return out
}

/** The subset of permission keys that are enabled on a live member. */
export function enabledPermissions(perms: Record<string, boolean> | undefined): string[] {
  if (!perms) return []
  return SAFE_MEMBER_PERMISSIONS.filter((key) => perms[key] === true)
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate safe-member configurations: a safe name, member name and member type
 * are required; at least one permission must be granted; any declared expiration
 * must be a positive epoch; and the (safe, member) natural key is unique.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSafeMemberSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = spec.sectionName
    const rawFields = sections[i]?.fields ?? {}

    if (!spec.safeName) {
      errors.push({ field: `${prefix}.safe_name`, message: 'Safe name is required', code: 'required' })
    }
    if (!spec.memberName) {
      errors.push({ field: `${prefix}.member_name`, message: 'Member name is required', code: 'required' })
    }
    if (!MEMBER_TYPE_SET.has(spec.memberType)) {
      errors.push({ field: `${prefix}.member_type`, message: `Unsupported member type "${spec.memberType}"`, code: 'invalid_member_type' })
    }
    if (spec.permissions.length === 0) {
      errors.push({ field: `${prefix}.permissions`, message: 'At least one permission must be granted', code: 'required' })
    }

    const exp = parsePositiveInt(rawFields.membership_expiration)
    if (exp.error) {
      errors.push({ field: `${prefix}.membership_expiration`, message: `Membership expiration ${exp.error} (Unix epoch seconds)`, code: 'invalid_expiration' })
    }

    if (spec.safeName && spec.memberName) {
      const key = memberKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.member_name`,
          message: `Duplicate member "${spec.memberName}" on safe "${spec.safeName}" — each (safe, member) may only be declared once`,
          code: 'duplicate_member',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
