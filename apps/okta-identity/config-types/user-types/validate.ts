import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta User Types API constraints -----------------------------------------
//
// A user type is a named container for a distinct user profile schema. Its
// logical identity is its NAME. Endpoints:
//   GET  /meta/types/user            — list
//   POST /meta/types/user            — create ({ name, displayName, description })
//   PUT  /meta/types/user/{typeId}   — replace ({ name, displayName, description })
//   DEL  /meta/types/user/{typeId}   — delete
// `name` is IMMUTABLE after creation, so it is only ever the match key. There is
// no lifecycle (no activate/deactivate). Profile ATTRIBUTES are managed by the
// Schemas API, not here.

/** name must start with a letter, then letters/digits/underscores. */
export const USER_TYPE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

/** Display-name / name length cap. */
export const MAX_USER_TYPE_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface UserTypeSpec {
  sectionName: string
  /** Machine name — the logical identity; immutable in Okta after creation. */
  name: string
  /** Human-friendly display name (required by Okta). */
  displayName: string
  /** Optional description; cleared when blank (PUT is a full replace). */
  description?: string
}

/** Shape of a user type returned by GET /meta/types/user (list) and /{id} (get). */
export interface LiveUserType {
  id?: string
  name?: string
  displayName?: string
  description?: string
  /** True on the org's built-in default user type — never deletable. */
  default?: boolean
  created?: string
  lastUpdated?: string
  createdBy?: string
  lastUpdatedBy?: string
  _links?: unknown
  [key: string]: unknown
}

/** Each canvas item describes one Okta user type. */
export function extractUserTypeSpecs(canvas: CanvasSnapshot): UserTypeSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      displayName: typeof fields.displayName === 'string' ? fields.displayName.trim() : '',
      description,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user-type configurations against the Okta User Types API. Static only
 * — it never contacts Okta:
 *   - name is required, matches the machine-name pattern, <= 255 chars, unique
 *   - displayName is required, <= 255 chars
 *
 * The "default type / assigned type cannot be deleted" rules depend on live state
 * (default flag, user assignments), so they are enforced in deploy / rollback.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserTypeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, valid machine name, <= 255 chars, unique
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'User type name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_USER_TYPE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `User type name must be ${MAX_USER_TYPE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (!USER_TYPE_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message:
            'User type name must start with a letter and contain only letters, digits and underscores',
          code: 'invalid_name',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate user type "${spec.name}" — each user type may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // displayName — required, capped length
    if (!spec.displayName) {
      errors.push({
        field: `${prefix}.displayName`,
        message: 'Display name is required',
        code: 'required',
      })
    } else if (spec.displayName.length > MAX_USER_TYPE_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.displayName`,
        message: `Display name must be ${MAX_USER_TYPE_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
