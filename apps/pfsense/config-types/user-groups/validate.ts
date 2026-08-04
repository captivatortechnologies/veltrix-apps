import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_LOCAL_NAME_LENGTH, groupKey, specFromItem } from './_shared'

const NAME_CHARSET_RE = /^[A-Za-z0-9.\-_]+$/

/**
 * Validate user-group items against pfSense's own rules (schema-only, no
 * live API calls — privilege-name validity is server-side only):
 *   - name required, <=16 chars (local-scope groups, verified), charset
 *     [A-Za-z0-9.\-_] (verified — UserGroup's own RegexValidator), unique per canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user group.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const spec = specFromItem(item)
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_LOCAL_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_LOCAL_NAME_LENGTH} characters or fewer for a local-scope group (got ${spec.name.length}).`, code: 'NAME_TOO_LONG' })
    } else if (!NAME_CHARSET_RE.test(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: 'Name may only contain letters, numbers, periods, hyphens and underscores.', code: 'INVALID_NAME' })
    } else {
      const key = groupKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate group name "${spec.name}" — each name may only be declared once per canvas.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (spec.priv.length > 0) {
      warnings.push({ field: `${prefix}.priv`, message: 'Privilege names are validated server-side only — an unrecognized privilege is rejected at deploy time.', code: 'PRIV_NOT_VERIFIED' })
    }
    if (spec.member.length > 0) {
      warnings.push({ field: `${prefix}.member`, message: 'Member usernames must already exist as local users — an unrecognized username is rejected at deploy time.', code: 'MEMBER_NOT_VERIFIED' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
