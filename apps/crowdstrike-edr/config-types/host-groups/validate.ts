import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Host Group API constraints -----------------------------------------------

/** group_type is case-sensitive in the API and immutable after creation. */
export const GROUP_TYPES = ['dynamic', 'static', 'staticByID'] as const
export type GroupType = (typeof GROUP_TYPES)[number]

export const MAX_GROUP_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface HostGroupSpec {
  sectionName: string
  name: string
  description?: string
  groupType: string
  assignmentRule?: string
}

/** Shape of a host group returned by GET /devices/combined/host-groups/v1. */
export interface LiveHostGroup {
  id?: string
  name?: string
  description?: string
  group_type?: string
  assignment_rule?: string
}

/** Each canvas section describes one Falcon host group. */
export function extractHostGroupSpecs(canvas: CanvasSnapshot): HostGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const assignmentRule =
      typeof fields.assignmentRule === 'string' && fields.assignmentRule.trim()
        ? fields.assignmentRule.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      groupType: typeof fields.groupType === 'string' ? fields.groupType.trim() : 'dynamic',
      assignmentRule,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate host group configurations against Host Group API constraints:
 * naming, case-sensitive group types, and assignment rules (dynamic
 * groups require one; static groups must not set one).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractHostGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group "${spec.name}" — each group may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // groupType — case-sensitive, immutable after creation
    if (!(GROUP_TYPES as readonly string[]).includes(spec.groupType)) {
      errors.push({
        field: `${prefix}.groupType`,
        message: `Group type must be one of: ${GROUP_TYPES.join(', ')} (case-sensitive)`,
        code: 'invalid_group_type',
      })
    }

    // assignmentRule — required for dynamic, forbidden otherwise
    if (spec.groupType === 'dynamic') {
      if (!spec.assignmentRule) {
        errors.push({
          field: `${prefix}.assignmentRule`,
          message:
            "Dynamic groups require an FQL assignment rule, e.g. platform_name:'Windows'+tags:'SensorGroupingTags/production'",
          code: 'required',
        })
      } else if (!balancedQuotes(spec.assignmentRule)) {
        errors.push({
          field: `${prefix}.assignmentRule`,
          message: 'Assignment rule has unbalanced quotes — check the FQL expression',
          code: 'invalid_fql',
        })
      }
    } else if (spec.assignmentRule) {
      errors.push({
        field: `${prefix}.assignmentRule`,
        message:
          'Assignment rules are only valid on dynamic groups — static group membership is managed via host actions',
        code: 'assignment_rule_conflict',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Cheap sanity check on FQL: single quotes must pair up (\' escapes ignored). */
function balancedQuotes(fql: string): boolean {
  const unescaped = fql.replace(/\\'/g, '')
  return (unescaped.match(/'/g) ?? []).length % 2 === 0
}
