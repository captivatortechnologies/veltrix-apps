import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidFilterJson } from './_shared'

/**
 * Validate alert-exclusion items: a non-empty name and a required, valid-JSON
 * filter (the exclusion criteria). Static — no target access required. The name
 * doubles as identity, so a duplicate name is flagged (last one wins). The
 * comment is optional and `disabled` is a checkbox (always boolean). VERIFY the
 * exclusion schema against a live Cortex XDR tenant — no public schema is
 * documented.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one alert exclusion.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const filter = String(item.fields.filter ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Exclusion name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Exclusion ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!filter) {
      errors.push({ field: `items[${i}].filter`, message: 'Filter (exclusion criteria) is required.', code: 'EMPTY_FILTER' })
    } else if (!isValidFilterJson(filter)) {
      errors.push({ field: `items[${i}].filter`, message: 'Filter must be valid JSON.', code: 'INVALID_FILTER' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
