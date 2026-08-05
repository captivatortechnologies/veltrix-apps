import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Qualys user roles (the `user_role` Add/Edit User parameter).
export const USER_ROLE_VALUES = ['manager', 'unit_manager', 'scanner', 'reader', 'contact', 'administrator'] as const
export type UserRole = (typeof USER_ROLE_VALUES)[number]

// Roles for which Qualys rejects an `asset_groups` assignment outright.
const ROLES_WITHOUT_ASSET_GROUPS = new Set<string>(['manager', 'unit_manager'])

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface UserSpec {
  sectionName: string
  email: string
  firstName: string
  lastName: string
  jobTitle: string
  userRole: string
  businessUnit: string
  phone: string
  address1: string
  address2: string
  city: string
  country: string
  state: string
  zipCode: string
  externalId: string
  assetGroups: string
  sendEmail: boolean
}

/**
 * Shape of a user account parsed from a `user_list.php` block. Qualys assigns
 * the `login` itself (it cannot be chosen on create), so it is a live-resolved
 * artifact rather than desired state — reconciliation keys on `email` instead
 * (see deploy.ts). Only fields this app can confidently diff are kept.
 */
export interface LiveUser {
  login: string
  id: string
  email: string
  firstName: string
  lastName: string
  jobTitle: string
}

/** The email natural key — a user's logical identity for reconciliation. */
export function userKey(spec: { email: string }): string {
  return spec.email.trim().toLowerCase()
}

/** Each canvas item describes one Qualys user account. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (key: string): string => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
    return {
      sectionName: section.name,
      email: str('email'),
      firstName: str('first_name'),
      lastName: str('last_name'),
      jobTitle: str('job_title'),
      userRole: str('user_role'),
      businessUnit: str('business_unit') || 'Unassigned',
      phone: str('phone'),
      address1: str('address1'),
      address2: str('address2'),
      city: str('city'),
      country: str('country'),
      state: str('state'),
      zipCode: str('zip_code'),
      externalId: str('external_id'),
      assetGroups: str('asset_groups'),
      sendEmail: fields.send_email !== false,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user account configurations: the fields Qualys requires to add a
 * user (email, name, job title, role, business unit, address1, city, country)
 * must be present, the role must be a supported value, asset groups may only be
 * declared for Scanner/Reader/Contact roles (Qualys rejects them for
 * Manager/Unit Manager), and each email must be unique.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserSpecs(ctx.canvas)
  const seen = new Set<string>()

  const required: Array<[keyof UserSpec, string, string]> = [
    ['email', 'email', 'Email is required'],
    ['firstName', 'first_name', 'First name is required'],
    ['lastName', 'last_name', 'Last name is required'],
    ['jobTitle', 'job_title', 'Job title is required'],
    ['userRole', 'user_role', 'User role is required'],
    ['address1', 'address1', 'Address line 1 is required'],
    ['city', 'city', 'City is required'],
    ['country', 'country', 'Country is required'],
  ]

  for (const spec of specs) {
    const prefix = spec.sectionName

    for (const [key, field, message] of required) {
      if (!spec[key]) errors.push({ field: `${prefix}.${field}`, message, code: 'required' })
    }

    if (spec.userRole && !USER_ROLE_VALUES.includes(spec.userRole as UserRole)) {
      errors.push({
        field: `${prefix}.user_role`,
        message: `Unsupported user role "${spec.userRole}" — use one of ${USER_ROLE_VALUES.join(', ')}`,
        code: 'invalid_value',
      })
    }

    if (spec.assetGroups && ROLES_WITHOUT_ASSET_GROUPS.has(spec.userRole)) {
      errors.push({
        field: `${prefix}.asset_groups`,
        message: `Asset groups cannot be assigned when the user role is "${spec.userRole}" (Qualys rejects this combination)`,
        code: 'invalid_combination',
      })
    }

    if (spec.email) {
      const key = userKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.email`,
          message: `Duplicate user "${spec.email}" — each email may only be declared once`,
          code: 'duplicate_user',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
