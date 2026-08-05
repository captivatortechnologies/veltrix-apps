import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildLabelName } from './_shared'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one label.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = buildLabelName(item.fields)
    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Label name is required.', code: 'EMPTY_NAME' })
      return
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      warnings.push({ field: `items[${i}].name`, message: `Label "${name}" is listed more than once.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
