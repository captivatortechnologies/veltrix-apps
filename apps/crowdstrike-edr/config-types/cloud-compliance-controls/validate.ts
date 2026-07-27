import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/falcon'
import type { LiveEntity } from '../../lib/entityAdapter'

// --- Cloud Security custom compliance control constraints --------------------

export const MAX_CONTROL_NAME_LENGTH = 255
export const MAX_SECTION_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ControlSpec {
  sectionName: string
  name: string
  frameworkId: string
  section: string
  description?: string
  ruleIds: string[]
}

/** A parent framework reference embedded in a live control. */
export interface LiveControlFramework {
  uuid?: string
  name?: string
}

/**
 * Live custom compliance control as returned by
 * GET /cloud-policies/entities/compliance/controls/v1. The identifier is
 * `uuid`; `requirement` + `section_name` + the parent framework name are what
 * the rules query needs to resolve the control's assigned rule IDs (the control
 * entity itself does not carry them).
 */
export interface LiveControl extends LiveEntity {
  uuid?: string
  name?: string
  description?: string
  section_name?: string
  requirement?: string
  security_framework?: LiveControlFramework[]
  /** Last modifier recorded by Falcon — used for drift attribution when present. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Each canvas section describes one custom compliance control. */
export function extractControlSpecs(canvas: CanvasSnapshot): ControlSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    // De-duplicate assigned rule ids while preserving declared order.
    const ruleIds = Array.from(new Set(splitList(fields.ruleIds)))
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      frameworkId: typeof fields.frameworkId === 'string' ? fields.frameworkId.trim() : '',
      section: typeof fields.section === 'string' ? fields.section.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      ruleIds,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom compliance control configurations against Cloud Security
 * Policies API constraints: a control name, its parent framework UUID, and its
 * section are all required (the create API mandates framework_id, name and
 * section_name), and the control identity must be unique per canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractControlSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (control identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Control name is required', code: 'required' })
    } else if (spec.name.length > MAX_CONTROL_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Control name must be ${MAX_CONTROL_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // frameworkId (parent framework — required by the create API)
    if (!spec.frameworkId) {
      errors.push({
        field: `${prefix}.frameworkId`,
        message: 'Framework UUID is required — a control must belong to a framework',
        code: 'required',
      })
    }

    // section (required by the create API)
    if (!spec.section) {
      errors.push({ field: `${prefix}.section`, message: 'Section is required', code: 'required' })
    } else if (spec.section.length > MAX_SECTION_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.section`,
        message: `Section must be ${MAX_SECTION_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // duplicate control identity (framework + section + name)
    if (spec.name && spec.frameworkId && spec.section) {
      const key = `${spec.frameworkId}:${spec.section.toLowerCase()}:${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate control "${spec.name}" in section "${spec.section}" — each control may only be declared once per canvas`,
          code: 'duplicate_control',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
