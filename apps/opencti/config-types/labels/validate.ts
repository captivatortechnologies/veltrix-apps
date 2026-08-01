import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate label items: a non-empty value and an optional #hex color. Static — no
 * target access required. The value doubles as the label identity, so a duplicate
 * is flagged (last one wins).
 */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one label.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const value = String(item.fields.value ?? '').trim()
    const color = String(item.fields.color ?? '').trim()

    if (!value) {
      errors.push({ field: `items[${i}].value`, message: 'Label value is required.', code: 'EMPTY_VALUE' })
    } else {
      const key = value.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].value`,
          message: `Label "${value}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_VALUE',
        })
      } else {
        seen.add(key)
      }
    }

    if (color && !HEX_RE.test(color)) {
      errors.push({
        field: `items[${i}].color`,
        message: `Color "${color}" must be a #RGB or #RRGGBB hex value.`,
        code: 'INVALID_COLOR',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
