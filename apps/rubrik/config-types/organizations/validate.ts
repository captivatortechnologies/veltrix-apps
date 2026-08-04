import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeName } from './_shared'

/**
 * Validate Organization items: a non-empty, unique name. Static — no target
 * access required. The name is the organization's identity, so a duplicate name
 * is an error (Rubrik would collide on create).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organization.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = normalizeName(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Organization name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      errors.push({ field: `items[${i}].name`, message: `Organization name "${name}" is listed more than once.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
