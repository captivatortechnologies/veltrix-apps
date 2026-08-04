import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate status template items: a non-empty name and a required #hex color.
 * Static — no target access required. The name doubles as the identity, so a
 * duplicate is flagged (last one wins).
 */
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one status template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const color = String(item.fields.color ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Status template name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Status template "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!color) {
      errors.push({ field: `items[${i}].color`, message: 'Status template color is required.', code: 'EMPTY_COLOR' })
    } else if (!HEX_RE.test(color)) {
      errors.push({
        field: `items[${i}].color`,
        message: `Color "${color}" must be a #RGB or #RRGGBB hex value.`,
        code: 'INVALID_COLOR',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
