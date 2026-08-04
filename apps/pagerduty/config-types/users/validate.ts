import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractUserSpecs, isPlausibleEmail, VALID_ROLES, VALID_COLORS } from './_shared'

/**
 * Validate user items. Static — no target access required:
 *   - name is required
 *   - email is required, must look like an email, and must be unique across
 *     the canvas (its reconciliation identity)
 *   - role, when supplied, must be one of PagerDuty's accepted role values
 *   - color, when supplied, must be one of PagerDuty's accepted color values
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractUserSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'User name is required.', code: 'EMPTY_NAME' })
    }

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required.', code: 'EMPTY_EMAIL' })
    } else if (!isPlausibleEmail(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: `"${spec.email}" does not look like a valid email address.`, code: 'INVALID_EMAIL' })
    } else if (seen.has(spec.email.toLowerCase())) {
      warnings.push({
        field: `${prefix}.email`,
        message: `Email "${spec.email}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_EMAIL',
      })
    } else {
      seen.add(spec.email.toLowerCase())
    }

    if (spec.role && !VALID_ROLES.has(spec.role)) {
      errors.push({
        field: `${prefix}.role`,
        message: `role must be one of ${[...VALID_ROLES].join(' / ')}.`,
        code: 'INVALID_ROLE',
      })
    }

    if (spec.color && !VALID_COLORS.has(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: `color must be one of ${[...VALID_COLORS].join(' / ')}.`,
        code: 'INVALID_COLOR',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
