import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'

// --- User Management API constraints ------------------------------------------

/**
 * Loose email shape — the Falcon `uid` is the user's email address and the
 * identity every handler looks a user up by. Anything stricter risks rejecting
 * addresses Falcon itself accepts.
 */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface UserSpec {
  sectionName: string
  /** Falcon `uid`, lowercased — the user's identity in lookups and drift. */
  email: string
  firstName?: string
  lastName?: string
  /** Role ids to converge the user's DIRECT grants to. */
  roleIds: string[]
  /** Roles are only managed when at least one role id is declared. */
  manageRoles: boolean
}

/** Shape of a user returned by POST /user-management/entities/users/GET/v1. */
export interface LiveUser {
  uuid?: string
  uid?: string
  first_name?: string
  last_name?: string
  created_at?: string
  last_login_at?: string
  // Best-effort modifier fields for drift attribution — Falcon user resources
  // do not reliably expose these, so attribution is typically left unresolved.
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** One role grant returned by GET /user-management/combined/user-roles/v2. */
export interface LiveUserRole {
  role_id?: string
  role_name?: string
  user_uuid?: string
  cid?: string
}

/** Each canvas section describes one Falcon user. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const email = typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : ''
    const roleIds = splitList(fields.roleIds)

    return {
      sectionName: section.name,
      email,
      firstName:
        typeof fields.firstName === 'string' && fields.firstName.trim()
          ? fields.firstName.trim()
          : undefined,
      lastName:
        typeof fields.lastName === 'string' && fields.lastName.trim()
          ? fields.lastName.trim()
          : undefined,
      roleIds,
      manageRoles: roleIds.length > 0,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user configurations against User Management API constraints:
 * a valid, unique email (uid) per user. Roles are optional — a user item may
 * exist purely to invite/rename an account without managing its roles.
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

  for (const spec of specs) {
    const prefix = spec.sectionName

    // email (uid) — required, valid, unique
    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required', code: 'required' })
    } else {
      if (!EMAIL_RE.test(spec.email)) {
        errors.push({
          field: `${prefix}.email`,
          message: 'Email must be a valid address, e.g. user@example.com',
          code: 'invalid_format',
        })
      }
      if (seen.has(spec.email)) {
        errors.push({
          field: `${prefix}.email`,
          message: `Duplicate user "${spec.email}" — each user may only be declared once per canvas`,
          code: 'duplicate_email',
        })
      }
      seen.add(spec.email)
    }

    // A user created without a name shows blank in the Falcon console — allowed
    // but worth flagging so it is not accidental.
    if (!spec.firstName && !spec.lastName) {
      warnings.push({
        field: `${prefix}.firstName`,
        message: 'No first or last name set — the user will appear without a name in Falcon',
        code: 'no_name',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
