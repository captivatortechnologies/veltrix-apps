import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { text } from './_shared'

/**
 * Validate Asset Ownership Type items: a non-empty name is required (it doubles as the identity).
 * Static — no target access required. A duplicate name is flagged (last wins) — the live batch API
 * would otherwise happily create two types with the same name.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one asset ownership type.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = text(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Ownership type name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Ownership type name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name.toLowerCase())
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
