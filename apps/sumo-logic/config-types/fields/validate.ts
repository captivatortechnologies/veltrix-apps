import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const FIELD_NAME_RE = /^[A-Za-z0-9_]+$/

/**
 * Validate custom-field items: a non-empty field name made of letters, numbers
 * and underscores. Static — no target access required. The field name is the
 * identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom field.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const fieldName = String(item.fields.fieldName ?? '').trim()

    if (!fieldName) {
      errors.push({ field: `items[${i}].fieldName`, message: 'Field name is required.', code: 'EMPTY_FIELD_NAME' })
      return
    }

    if (!FIELD_NAME_RE.test(fieldName)) {
      errors.push({
        field: `items[${i}].fieldName`,
        message: 'Field name may only contain letters, numbers and underscores.',
        code: 'INVALID_FIELD_NAME',
      })
    }

    const key = fieldName.toLowerCase()
    if (seen.has(key)) {
      warnings.push({
        field: `items[${i}].fieldName`,
        message: `Field name "${fieldName}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_FIELD_NAME',
      })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
