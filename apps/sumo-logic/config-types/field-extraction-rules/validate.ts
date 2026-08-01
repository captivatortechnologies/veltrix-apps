import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate field-extraction-rule items: a non-empty name, a non-empty scope, and
 * a non-empty parse expression. Static — no target access required. The rule name
 * is the identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one field extraction rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const scope = String(item.fields.scope ?? '').trim()
    const parseExpression = String(item.fields.parseExpression ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Rule name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!scope) {
      errors.push({ field: `items[${i}].scope`, message: 'Scope is required (e.g. _sourceCategory=prod/nginx).', code: 'EMPTY_SCOPE' })
    }

    if (!parseExpression) {
      errors.push({ field: `items[${i}].parseExpression`, message: 'Parse expression is required.', code: 'EMPTY_PARSE_EXPRESSION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
