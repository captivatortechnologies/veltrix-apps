import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate authentik Scope Mapping items: a non-empty name (the upsert
 * identity), a required scope name, and a required expression. Static (no
 * target access, no expression execution/linting).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scope mapping.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const scopeName = String(item.fields.scope_name ?? '').trim()
    const expression = String(item.fields.expression ?? '')

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Mapping name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Mapping name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!scopeName) {
      errors.push({ field: `items[${i}].scope_name`, message: 'Scope name is required.', code: 'EMPTY_SCOPE_NAME' })
    }

    if (!expression.trim()) {
      errors.push({ field: `items[${i}].expression`, message: 'Expression is required.', code: 'EMPTY_EXPRESSION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
