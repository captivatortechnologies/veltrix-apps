import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO } from './_shared'

/**
 * Validate sharing-group items: a non-empty name and a yes/no releasable flag.
 * Static — no target access required. The name doubles as the sharing group
 * identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sharing group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const releasable = String(item.fields.releasable ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Sharing group name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Sharing group name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (!YES_NO.has(releasable)) {
      errors.push({ field: `items[${i}].releasable`, message: `Releasable must be yes or no (got "${releasable}").`, code: 'INVALID_RELEASABLE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
