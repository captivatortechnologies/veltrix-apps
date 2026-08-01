import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  extractUserGroupSpecs,
  MEMBERSHIP_METHOD_SET,
  MEMBERSHIP_METHODS,
  EMAIL_RE,
} from './_shared'

/**
 * Validate User Group items: a non-empty, unique name (the logical identity),
 * an optional well-formed email, and a supported membership method. Static — no
 * target access required.
 *
 * A DYNAMIC_AUTOMATED group derives its membership from a member query that this
 * config type does not author yet, so it is accepted but warned about.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractUserGroupSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one User Group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'User Group name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'User Group name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate User Group "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (spec.email && !EMAIL_RE.test(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: `"${spec.email}" is not a valid email address.`, code: 'INVALID_EMAIL' })
    }

    if (!MEMBERSHIP_METHOD_SET.has(spec.membershipMethod)) {
      errors.push({
        field: `${prefix}.membershipMethod`,
        message: `Membership method must be one of ${MEMBERSHIP_METHODS.join(', ')}.`,
        code: 'INVALID_MEMBERSHIP_METHOD',
      })
    } else if (spec.membershipMethod === 'DYNAMIC_AUTOMATED') {
      warnings.push({
        field: `${prefix}.membershipMethod`,
        message:
          `"${spec.name || 'group'}" uses DYNAMIC_AUTOMATED — JumpCloud derives its membership from a ` +
          'member query that must be configured in JumpCloud; this config type does not author it yet.',
        code: 'DYNAMIC_NEEDS_QUERY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
