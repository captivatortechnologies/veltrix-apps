import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate group items: a non-empty name; description and the two boolean toggles
 * are optional. Static — no target access required. The name doubles as the group
 * identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const confidenceRaw = item.fields.confidence_level_max

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Group "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (confidenceRaw !== undefined && confidenceRaw !== null && confidenceRaw !== '') {
      const confidence = Number(confidenceRaw)
      if (!Number.isFinite(confidence) || !Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
        errors.push({
          field: `items[${i}].confidence_level_max`,
          message: `Max confidence level "${String(confidenceRaw)}" must be an integer between 0 and 100.`,
          code: 'INVALID_CONFIDENCE_LEVEL',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
