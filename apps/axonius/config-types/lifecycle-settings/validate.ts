import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseOverrides } from './_shared'

/**
 * Validate the Lifecycle Settings singleton: at most one declared item, and
 * `overrides` parses to a JSON object. Static — no target access; the
 * top-level key names are tenant/version-specific and not validated against a
 * live schema.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the Lifecycle Settings item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'Lifecycle Settings is a singleton — declare it only once per canvas.', code: 'SINGLETON' })
  }

  items.forEach((item, i) => {
    const overrides = parseOverrides(item.fields.overrides)
    if (!overrides.ok) {
      errors.push({ field: `items[${i}].overrides`, message: `Settings overrides must be a valid JSON object: ${overrides.error}`, code: 'INVALID_OVERRIDES' })
    } else if (Object.keys(overrides.value).length === 0) {
      warnings.push({ field: `items[${i}].overrides`, message: 'No override keys declared — deploy will not change anything.', code: 'EMPTY_OVERRIDES' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
