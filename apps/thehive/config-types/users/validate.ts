import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeLogin } from './_shared'

/**
 * Validate user items: a non-empty login, name and profile. Static — no target
 * access required. The login is the stable identity, so a duplicate login is
 * flagged (last one wins). A malformed email is warned (TheHive stores it but a
 * typo is worth catching).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const login = normalizeLogin(item.fields.login)
    const name = String(item.fields.name ?? '').trim()
    const profile = String(item.fields.profile ?? '').trim()
    const email = String(item.fields.email ?? '').trim()

    if (!login) {
      errors.push({ field: `items[${i}].login`, message: 'User login is required.', code: 'EMPTY_LOGIN' })
    } else if (seen.has(login)) {
      warnings.push({ field: `items[${i}].login`, message: `User login "${login}" is listed more than once; the last one wins.`, code: 'DUPLICATE_LOGIN' })
    } else {
      seen.add(login)
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'User name is required.', code: 'EMPTY_NAME' })
    }
    if (!profile) {
      errors.push({ field: `items[${i}].profile`, message: 'User profile (role) is required.', code: 'EMPTY_PROFILE' })
    }
    if (email && !EMAIL_RE.test(email)) {
      warnings.push({ field: `items[${i}].email`, message: `"${email}" does not look like a valid email address.`, code: 'INVALID_EMAIL' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
