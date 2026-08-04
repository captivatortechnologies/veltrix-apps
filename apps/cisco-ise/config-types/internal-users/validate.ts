import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_USERNAME_LENGTH, MAX_DESCRIPTION_LENGTH, specFromItem } from './_shared'

/**
 * Validate internal user items: a non-empty, uniquely-named username within
 * ERS's length limits, and (a light check) a well-formed email when given.
 * `password` being blank is only a WARNING — ISE requires it on create but
 * this app can't know statically whether the user already exists, and a
 * blank password on an existing user intentionally leaves it unchanged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one internal user.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.username) {
      errors.push({ field: `items[${i}].username`, message: 'Username is required.', code: 'EMPTY_USERNAME' })
    } else if (spec.username.length > MAX_USERNAME_LENGTH) {
      errors.push({
        field: `items[${i}].username`,
        message: `Username must be ${MAX_USERNAME_LENGTH} characters or fewer (got ${spec.username.length}).`,
        code: 'USERNAME_TOO_LONG',
      })
    } else {
      const key = spec.username.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].username`, message: `Username "${spec.username}" is listed more than once; the last one wins.`, code: 'DUPLICATE_USERNAME' })
      } else {
        seen.add(key)
      }
    }

    if (spec.email && !spec.email.includes('@')) {
      errors.push({ field: `items[${i}].email`, message: `"${spec.email}" does not look like a valid email address.`, code: 'INVALID_EMAIL' })
    }

    if (!spec.password) {
      warnings.push({
        field: `items[${i}].password`,
        message: 'Password is blank — ISE requires one when creating a NEW user; an EXISTING user keeps their current password unchanged.',
        code: 'PASSWORD_BLANK',
      })
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
