import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, extractSiteSpecs } from './_shared'

/**
 * Validate site items: a unique, non-empty name within the length limit. A site
 * has no other configurable fields. Static — no target access required.
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSiteSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one site.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'required' })
      return
    }
    if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
        code: 'too_long',
      })
    }
    const key = spec.name.toLowerCase()
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate site "${spec.name}" — each may only be declared once per canvas.`,
        code: 'duplicate_name',
      })
    }
    seen.add(key)
  })

  return { valid: errors.length === 0, errors, warnings }
}
