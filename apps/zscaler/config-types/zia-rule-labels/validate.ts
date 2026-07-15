import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Rule Labels constraints ---------------------------------------------

/** ZIA caps a rule label name and description at 255 characters. */
export const MAX_LABEL_NAME_LENGTH = 255
export const MAX_LABEL_DESCRIPTION_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface LabelSpec {
  sectionName: string
  /** The rule label name — its logical identity (list + match). */
  name: string
  description?: string
}

/** Shape of a rule label returned by GET /ruleLabels. */
export interface LiveLabel {
  id?: number
  name?: string
  description?: string
}

/** Each canvas item describes one ZIA rule label. */
export function extractLabelSpecs(canvas: CanvasSnapshot): LabelSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate rule label configurations against ZIA constraints: a name is
 * required and capped at 255 chars, the description is capped at 255 chars, and
 * the name — a label's logical identity — must be unique across the canvas
 * (matched case-insensitively, since ZIA rejects labels differing only in case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLabelSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule label name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_LABEL_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule label name must be ${MAX_LABEL_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule label "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_label',
        })
      }
      seen.add(key)
    }

    if (spec.description && spec.description.length > MAX_LABEL_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_LABEL_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
