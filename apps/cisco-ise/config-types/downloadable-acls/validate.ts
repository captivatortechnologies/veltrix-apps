import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, DACL_TYPES, specFromItem } from './_shared'

/**
 * Validate DACL items: a non-empty, uniquely-named DACL with non-empty ACL
 * content and a valid ACL type, within ERS's length limits.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Downloadable ACL.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const rawType = String(item.fields.dacl_type ?? '').trim().toUpperCase()

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'DACL name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `items[${i}].name`,
        message: `DACL name must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`,
        code: 'NAME_TOO_LONG',
      })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `DACL name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (rawType && !DACL_TYPES.has(rawType)) {
      errors.push({ field: `items[${i}].dacl_type`, message: `ACL type must be one of ${[...DACL_TYPES].join(', ')} (got "${rawType}").`, code: 'INVALID_DACL_TYPE' })
    }

    if (!spec.dacl) {
      errors.push({ field: `items[${i}].dacl`, message: 'ACL content is required — ISE rejects an empty DACL.', code: 'EMPTY_DACL_CONTENT' })
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
