import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractSystemGroupSpecs } from './_shared'

/**
 * Validate System Group items: a non-empty, unique name (the logical identity)
 * and an optional description. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractSystemGroupSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one System Group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'System Group name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'System Group name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate System Group "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (spec.description.length > 500) {
      errors.push({ field: `${prefix}.description`, message: 'Description must be 500 characters or fewer.', code: 'MAX_LENGTH' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
