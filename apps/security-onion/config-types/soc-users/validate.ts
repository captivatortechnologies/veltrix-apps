import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate SOC user items: a basic email address and a known state. Static — no
 * target access required. This type only manages enable/disable of EXISTING users;
 * it does not create users or set passwords (so-user add is interactive).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one SOC user.', code: 'EMPTY' })
  }

  const seen = new Map<string, string>()
  items.forEach((item, i) => {
    const email = String(item.fields.email ?? '').trim()
    const action = String(item.fields.action ?? '')

    if (!EMAIL_RE.test(email)) {
      errors.push({ field: `items[${i}].email`, message: `A valid email is required (got "${email}").`, code: 'INVALID_EMAIL' })
    } else if (seen.has(email) && seen.get(email) !== action) {
      warnings.push({ field: `items[${i}].email`, message: `${email} is listed with conflicting states; the last one wins.`, code: 'CONFLICTING_EMAIL' })
    } else if (seen.has(email)) {
      warnings.push({ field: `items[${i}].email`, message: `${email} is listed more than once.`, code: 'DUPLICATE_EMAIL' })
    } else {
      seen.set(email, action)
    }

    if (action !== 'enable' && action !== 'disable') {
      errors.push({ field: `items[${i}].action`, message: `State must be "enable" or "disable" (got "${action}").`, code: 'INVALID_ACTION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
