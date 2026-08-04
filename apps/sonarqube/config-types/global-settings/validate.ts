import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseValueLines } from './_shared'

/**
 * Validate global-setting items: a non-empty key, and exactly one of `value` / `values`
 * populated — the API takes "value" OR "values", never neither or both. Static — no target
 * access required. The key is the setting's identity, so a duplicate key is flagged (last
 * one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one setting.', code: 'EMPTY' })
  }

  const seenKeys = new Set<string>()

  items.forEach((item, i) => {
    const key = String(item.fields.key ?? '').trim()
    const value = String(item.fields.value ?? '').trim()
    const values = parseValueLines(item.fields.values)

    if (!key) {
      errors.push({ field: `items[${i}].key`, message: 'Setting key is required.', code: 'EMPTY_KEY' })
    } else if (seenKeys.has(key)) {
      warnings.push({ field: `items[${i}].key`, message: `Setting "${key}" is listed more than once; the last one wins.`, code: 'DUPLICATE_KEY' })
    } else {
      seenKeys.add(key)
    }

    const hasValue = value !== ''
    const hasValues = values.length > 0
    if (!hasValue && !hasValues) {
      errors.push({
        field: `items[${i}].value`,
        message: 'Provide either a Value or one or more Values (one per line).',
        code: 'EMPTY_VALUE',
      })
    } else if (hasValue && hasValues) {
      errors.push({
        field: `items[${i}].value`,
        message: 'Provide either a Value or Values, not both — SonarQube accepts exactly one.',
        code: 'AMBIGUOUS_VALUE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
