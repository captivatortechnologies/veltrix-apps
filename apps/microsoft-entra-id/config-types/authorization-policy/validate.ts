import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra tenant authorization-policy constraints ---------------------------

/** Who may invite external users — the accepted allowInvitesFrom values. */
export const ALLOW_INVITES_FROM = new Set([
  'none',
  'adminsAndGuestInviters',
  'adminsGuestInvitersAndAllMembers',
  'everyone',
])

/** The three role templateIds Graph accepts for guestUserRoleId. */
export const GUEST_USER_ROLE_IDS = new Set([
  'a0b1b346-4d3e-4e8b-98f8-753987be4970', // User
  '10dae51f-b6af-4016-8d66-8c2a99b929b3', // Guest User
  '2af84b1e-32c8-42b7-82bc-daa82404023b', // Restricted Guest User
])

export interface AuthorizationPolicySpec {
  itemId?: string
  /** '' means "do not manage this field" — only non-empty values are sent. */
  allowInvitesFrom: string
  allowedToUseSSPR: boolean
  allowUserConsentForRiskyApps: boolean
  blockMsolPowerShell: boolean
  allowEmailVerifiedUsersToJoinOrganization: boolean
  allowedToSignUpEmailBasedSubscriptions: boolean
  /** '' means "do not manage"; otherwise one of GUEST_USER_ROLE_IDS. */
  guestUserRoleId: string
  /** Raw JSON text for defaultUserRolePermissions, or '' to leave it untouched. */
  defaultUserRolePermissions: string
  /** permissionGrantPolicy ids or display names — resolved + formatted at deploy time.
   *  Empty means "not managed through this picker" (see deploy.ts precedence rule). */
  permissionGrantPoliciesAssigned: string[]
}

/** The tenant authorization policy singleton as returned by Graph. */
export interface LiveAuthorizationPolicy {
  id?: string
  allowInvitesFrom?: string
  allowedToUseSSPR?: boolean
  allowUserConsentForRiskyApps?: boolean
  blockMsolPowerShell?: boolean
  allowEmailVerifiedUsersToJoinOrganization?: boolean
  allowedToSignUpEmailBasedSubscriptions?: boolean
  guestUserRoleId?: string | null
  defaultUserRolePermissions?: Record<string, unknown> | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Coerce a multiselect (array) or a delimited string into trimmed tokens. */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Parse a JSON string into a plain object, or null when it isn't a JSON object. */
export function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Recursively sort object keys so equal objects stringify identically. */
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** Canonical form of a plain object for key-order-insensitive comparison. */
export function canonicalObject(v: unknown): string {
  return JSON.stringify(sortValue(v ?? {}))
}

export function extractAuthorizationPolicySpecs(canvas: CanvasSnapshot): AuthorizationPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      allowInvitesFrom: asString(f.allowInvitesFrom),
      allowedToUseSSPR: asBool(f.allowedToUseSSPR),
      allowUserConsentForRiskyApps: asBool(f.allowUserConsentForRiskyApps),
      blockMsolPowerShell: asBool(f.blockMsolPowerShell),
      allowEmailVerifiedUsersToJoinOrganization: asBool(f.allowEmailVerifiedUsersToJoinOrganization),
      allowedToSignUpEmailBasedSubscriptions: asBool(f.allowedToSignUpEmailBasedSubscriptions),
      guestUserRoleId: asString(f.guestUserRoleId),
      defaultUserRolePermissions: asString(f.defaultUserRolePermissions),
      permissionGrantPoliciesAssigned: asStringArray(f.permissionGrantPoliciesAssigned),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAuthorizationPolicySpecs(ctx.canvas)

  if (specs.length > 1) {
    errors.push({
      field: 'items',
      message: 'The tenant authorization policy is a singleton — declare it only once per canvas',
      code: 'singleton',
    })
  }

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (spec.allowInvitesFrom && !ALLOW_INVITES_FROM.has(spec.allowInvitesFrom)) {
      errors.push({
        field: `${prefix}.allowInvitesFrom`,
        message: `allowInvitesFrom "${spec.allowInvitesFrom}" is not one of ${[...ALLOW_INVITES_FROM].join(', ')}`,
        code: 'invalid_enum',
      })
    }

    if (spec.guestUserRoleId && !GUEST_USER_ROLE_IDS.has(spec.guestUserRoleId)) {
      errors.push({
        field: `${prefix}.guestUserRoleId`,
        message: 'guestUserRoleId must be one of the User, Guest User or Restricted Guest User role template ids',
        code: 'invalid_guest_role',
      })
    }

    if (spec.defaultUserRolePermissions) {
      const parsed = parseObject(spec.defaultUserRolePermissions)
      if (!parsed) {
        errors.push({
          field: `${prefix}.defaultUserRolePermissions`,
          message: 'Default user role permissions must be a valid JSON object',
          code: 'invalid_json',
        })
      } else if (spec.permissionGrantPoliciesAssigned.length && 'permissionGrantPoliciesAssigned' in parsed) {
        warnings.push({
          field: `${prefix}.permissionGrantPoliciesAssigned`,
          message:
            'Both the App Consent Policies picker and a permissionGrantPoliciesAssigned key in the JSON field are set — the picker takes precedence',
          code: 'picker_overrides_json',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
