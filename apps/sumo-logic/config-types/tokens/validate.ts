import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate token items: a non-empty name and a recognized status. Static — no
 * target access required. The name is the identity, so a duplicate is flagged
 * (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one token.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const status = String(item.fields.status ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Token name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Token name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (status && status !== 'Active' && status !== 'Inactive') {
      errors.push({ field: `items[${i}].status`, message: 'Status must be Active or Inactive.', code: 'INVALID_STATUS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
