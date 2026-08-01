import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CUSTOM_FIELD_TYPES, parseOptions } from './_shared'

/**
 * Validate custom-field items: a non-empty name and a recognised type. Static —
 * no target access required. The field name is the stable identity, so a
 * duplicate name is flagged (last one wins). An `options` list on a boolean/date
 * field is meaningless, so it is warned.
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
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Custom field name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Custom field name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(type)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be one of ${CUSTOM_FIELD_TYPES.join(', ')}.`, code: 'INVALID_TYPE' })
    }

    if (parseOptions(item.fields.options).length > 0 && (type === 'boolean' || type === 'date')) {
      warnings.push({ field: `items[${i}].options`, message: `Options are ignored for a ${type} custom field.`, code: 'OPTIONS_IGNORED' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
