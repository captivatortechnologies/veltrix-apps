import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Groups API constraints ------------------------------------------

/** A user group's name is capped at 255 chars. */
export const MAX_USER_GROUP_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface UserGroupSpec {
  sectionName: string
  /** Group name — the logical identity of the group. */
  name: string
}

/** Shape of a user group returned by GET /groups. */
export interface LiveUserGroup {
  /** Numeric group id — used as {group_id} in the update/delete paths. */
  id?: number
  /** Stable uuid Tenable also assigns to the group. */
  uuid?: string
  name?: string
  user_count?: number
}

/** Each canvas section describes one Tenable user group (by name). */
export function extractUserGroupSpecs(canvas: CanvasSnapshot): UserGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user group configurations against Tenable Groups API constraints:
 * a name is required and capped at 255 chars, and the name — a group's logical
 * identity — must be unique across the canvas. Static rules only; no network.
 *
 * Membership is deliberately out of scope (managed via separate endpoints), so
 * there are no member fields to validate here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'User group name is required', code: 'required' })
    } else if (spec.name.length > MAX_USER_GROUP_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `User group name must be ${MAX_USER_GROUP_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // name is the group's logical identity — dedupe on it. Matched exactly
    // (not case-folded): Tenable stores the name as a literal string, so two
    // names differing only in case are treated as distinct here.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate user group "${spec.name}" — each group name may only be declared once per canvas`,
          code: 'duplicate_group',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
