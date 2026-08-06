import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractUserAccountSpecs, parseRights, userAccountKey } from './_shared'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const VALID_ROLES = new Set([1, 2, 3, 5])

/**
 * Validate user account(s): a well-formed unique email, a full name, a
 * documented role, and — when Role is Custom — parseable Rights JSON.
 * Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user account.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserAccountSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required.', code: 'REQUIRED' })
    } else if (!EMAIL_RE.test(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: `"${spec.email}" is not a valid email address.`, code: 'INVALID_EMAIL' })
    } else {
      const key = userAccountKey(spec.email)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.email`, message: `Email "${spec.email}" is listed more than once; the last one wins.`, code: 'DUPLICATE_EMAIL' })
      } else {
        seen.add(key)
      }
    }

    if (!spec.fullName) {
      errors.push({ field: `${prefix}.fullName`, message: 'Full Name is required.', code: 'REQUIRED' })
    }

    if (spec.role !== 0 && !VALID_ROLES.has(spec.role)) {
      errors.push({ field: `${prefix}.role`, message: `Role ${spec.role} is not one of the documented values (1, 2, 3, 5).`, code: 'INVALID_ROLE' })
    }

    if (spec.rightsRaw) {
      const { error } = parseRights(spec)
      if (error) errors.push({ field: `${prefix}.rights`, message: error, code: 'INVALID_JSON' })
      else if (spec.role !== 5) {
        warnings.push({ field: `${prefix}.rights`, message: 'Rights is set but Role is not Custom (5) — GravityZone ignores Rights for a non-custom role.', code: 'RIGHTS_IGNORED' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
