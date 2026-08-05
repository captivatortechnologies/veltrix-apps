import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildListSpec } from './_shared'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom list.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = buildListSpec(item.fields)
    if (!spec.id) {
      errors.push({ field: `items[${i}].name`, message: 'List name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (spec.error) {
      errors.push({ field: `items[${i}].content`, message: spec.error, code: 'EMPTY_CONTENT' })
      return
    }
    const key = spec.id.toLowerCase()
    if (seen.has(key)) {
      warnings.push({ field: `items[${i}].name`, message: `List name "${spec.id}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
