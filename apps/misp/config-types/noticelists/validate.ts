import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NOTICELIST_STATES } from './_shared'

/**
 * Validate noticelist items: a non-empty name and a known enable state. Static —
 * no target access required. The name doubles as the noticelist identity, so a
 * duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one noticelist.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const state = String(item.fields.state ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Noticelist name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Noticelist name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (!NOTICELIST_STATES.has(state)) {
      errors.push({ field: `items[${i}].state`, message: `State must be enabled or disabled (got "${state}").`, code: 'INVALID_STATE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
