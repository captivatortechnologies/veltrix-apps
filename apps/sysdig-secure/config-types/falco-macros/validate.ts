import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate Falco-macro items: a non-empty unique name and a non-empty condition.
 * Static — no target access required. The macro name is the stable identity, so
 * a duplicate name is flagged (last one wins on deploy).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Falco macro.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const condition = String(item.fields.condition ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Macro name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Macro name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!condition) {
      errors.push({ field: `items[${i}].condition`, message: 'Falco condition expression is required.', code: 'EMPTY_CONDITION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
