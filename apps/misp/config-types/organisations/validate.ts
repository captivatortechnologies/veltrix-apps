import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO } from './_shared'

/**
 * Validate organisation items: a non-empty name and a yes/no local flag.
 * Nationality is optional. Static — no target access required. The name doubles as
 * the organisation identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organisation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const local = String(item.fields.local ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Organisation name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Organisation name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (!YES_NO.has(local)) {
      errors.push({ field: `items[${i}].local`, message: `Local must be yes or no (got "${local}").`, code: 'INVALID_LOCAL' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
