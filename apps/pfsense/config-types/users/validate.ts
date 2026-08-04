import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, isValidExpires, specFromItem, userKey } from './_shared'

const NAME_CHARSET_RE = /^[A-Za-z0-9.\-_]+$/

/**
 * Validate user items against pfSense's own rules (schema-only, no live API
 * calls — privilege-name and username-collision-with-a-system-account
 * checks are server-side only):
 *   - name required, charset [A-Za-z0-9.\-_] (verified), <=32 chars, unique per canvas
 *   - password required to create a NEW user (this app cannot tell "new" vs
 *     "existing" without a live connection, so this is a WARNING, not an error)
 *   - expires, when set, must be MM/DD/YYYY
 *   - descr length-capped
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Username is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Username must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`, code: 'NAME_TOO_LONG' })
    } else if (!NAME_CHARSET_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: 'Username may only contain letters, numbers, periods, hyphens and underscores.', code: 'INVALID_NAME' })
    } else {
      const key = userKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate username "${spec.name}" — each username may only be declared once per canvas.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (!spec.password) {
      warnings.push({
        field: `${prefix}.password`,
        message: 'No password set — required when this user does not already exist. Leaving it blank on an existing user keeps its current password unchanged.',
        code: 'NO_PASSWORD_SET',
      })
    }

    if (spec.expires && !isValidExpires(spec.expires)) {
      errors.push({ field: `${prefix}.expires`, message: `"${spec.expires}" is not a valid MM/DD/YYYY date.`, code: 'INVALID_EXPIRES' })
    }

    if (spec.priv.length > 0) {
      warnings.push({ field: `${prefix}.priv`, message: 'Privilege names are validated server-side only — an unrecognized privilege is rejected at deploy time.', code: 'PRIV_NOT_VERIFIED' })
    }

    if (spec.descr.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.descr`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.descr.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
