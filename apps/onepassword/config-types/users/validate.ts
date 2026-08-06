import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- 1Password SCIM Bridge Users constraints ----------------------------------
// Standard SCIM 2.0 (RFC 7643 core User schema / RFC 7644 protocol):
//
// GET          /Users            - list (ListResponse envelope)
// POST         /Users            - create
// GET          /Users/{id}       - read
// PATCH        /Users/{id}       - partial update (PatchOp) - profile fields
//                                  and the active/suspended toggle
//
// A user's logical identity in this config type is their SCIM `userName`
// (their email address) - the bridge has no upsert, so this app matches an
// existing user by userName, the same convention used by every other
// name/email-keyed config type across this codebase.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface UserSpec {
  sectionName: string
  /** SCIM userName - this item's identity (the user's email address). */
  userName: string
  givenName: string
  familyName: string
  active: boolean
}

/** Shape of a SCIM User resource, as returned by GET /Users and GET /Users/{id}. */
export interface LiveUser {
  id?: string
  userName?: string
  name?: { givenName?: string; familyName?: string }
  emails?: Array<{ value?: string; primary?: boolean }>
  active?: boolean
  [key: string]: unknown
}

/** Each canvas item describes one 1Password user. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      userName: typeof fields.userName === 'string' ? fields.userName.trim() : '',
      givenName: typeof fields.givenName === 'string' ? fields.givenName.trim() : '',
      familyName: typeof fields.familyName === 'string' ? fields.familyName.trim() : '',
      active: fields.active !== false,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user configurations against the SCIM Users model. Static only - it
 * never contacts the SCIM Bridge:
 *   - userName is required, must look like an email address, and unique
 *     across the canvas (this config type's identity)
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
  const seenUserNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.userName) {
      errors.push({ field: `${prefix}.userName`, message: 'Email (Username) is required', code: 'required' })
    } else if (!EMAIL_PATTERN.test(spec.userName)) {
      errors.push({
        field: `${prefix}.userName`,
        message: `"${spec.userName}" is not a valid email address`,
        code: 'invalid_email',
      })
    } else {
      const key = spec.userName.toLowerCase()
      if (seenUserNames.has(key)) {
        errors.push({
          field: `${prefix}.userName`,
          message: `Duplicate user "${spec.userName}" - each user may only be declared once per canvas`,
          code: 'duplicate_user',
        })
      }
      seenUserNames.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
