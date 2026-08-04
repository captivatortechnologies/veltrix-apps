import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { USERNAME_RE, MIN_USERNAME_LENGTH, MAX_USERNAME_LENGTH, specFromItem } from './_shared'

/**
 * Validate API-user items: a safe, correctly-sized username. `password` being
 * blank is only a WARNING — Wazuh requires it on create but an EXISTING user
 * keeps their current password unchanged, and validate has no live access to
 * tell which case applies (see deploy.ts, which hard-fails a create without
 * one). Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one API user.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.username) {
      errors.push({ field: `items[${i}].username`, message: 'Username is required.', code: 'EMPTY_NAME' })
    } else if (spec.username.length < MIN_USERNAME_LENGTH || spec.username.length > MAX_USERNAME_LENGTH || !USERNAME_RE.test(spec.username)) {
      errors.push({ field: `items[${i}].username`, message: `Username "${spec.username}" must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters, using only letters, numbers, dot, underscore, percent or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(spec.username)) {
      warnings.push({ field: `items[${i}].username`, message: `User ${spec.username} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.username)
    }

    if (!spec.password) {
      warnings.push({
        field: `items[${i}].password`,
        message: 'Password is blank — Wazuh requires one when creating a NEW user; an EXISTING user keeps their current password unchanged.',
        code: 'NO_PASSWORD',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
