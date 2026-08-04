import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractCustomEmailSpecs, CUSTOM_EMAIL_TYPES } from './_shared'

/**
 * Validate Custom Email items: a valid, unique `type` (the identity — JumpCloud
 * allows at most one override per type) and a required subject. Static — no
 * target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractCustomEmailSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Custom Email override.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Email Type is required.', code: 'EMPTY_TYPE' })
    } else if (!(CUSTOM_EMAIL_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `"${spec.type}" is not a recognized JumpCloud custom email type. Valid values: ${CUSTOM_EMAIL_TYPES.join(', ')}.`,
        code: 'INVALID_TYPE',
      })
    } else if (seen.has(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Duplicate email type "${spec.type}" — each type may only be declared once per canvas (and once per org, per the JumpCloud API).`,
        code: 'DUPLICATE_TYPE',
      })
    } else {
      seen.add(spec.type)
    }

    if (!spec.subject) {
      errors.push({ field: `${prefix}.subject`, message: `"${spec.type || 'email'}" requires a subject.`, code: 'EMPTY_SUBJECT' })
    }

    if (!spec.body) {
      warnings.push({
        field: `${prefix}.body`,
        message: `"${spec.type || 'email'}" has no body override — JumpCloud's default template body is used.`,
        code: 'NO_BODY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
