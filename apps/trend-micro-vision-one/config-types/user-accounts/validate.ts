import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ACCOUNT_STATUSES, AUTH_TYPES } from './_shared'

/**
 * Validate user-account items: a well-formed email, a non-empty role, a known
 * auth type, and — when provided — a known status and a description within
 * length. Static — no target access required. The email doubles as the account's
 * identity, so a duplicate email is flagged (last one wins).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ROLE = 128
const MAX_DESCRIPTION = 500

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user account.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const email = String(item.fields.email ?? '').trim()
    const role = String(item.fields.role ?? '').trim()
    const authType = String(item.fields.authType ?? '').trim()
    const status = String(item.fields.status ?? '').trim()
    const description = String(item.fields.description ?? '').trim()

    if (!email) {
      errors.push({ field: `items[${i}].email`, message: 'Email is required.', code: 'EMPTY_EMAIL' })
    } else if (!EMAIL_RE.test(email)) {
      errors.push({ field: `items[${i}].email`, message: `"${email}" is not a valid email address.`, code: 'INVALID_EMAIL' })
    } else {
      const key = email.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].email`, message: `Account ${email} is listed more than once; the last one wins.`, code: 'DUPLICATE_EMAIL' })
      } else {
        seen.add(key)
      }
    }

    if (!role) {
      errors.push({ field: `items[${i}].role`, message: 'Role is required.', code: 'EMPTY_ROLE' })
    } else if (role.length > MAX_ROLE) {
      errors.push({ field: `items[${i}].role`, message: `Role must be ${MAX_ROLE} characters or fewer (got ${role.length}).`, code: 'ROLE_TOO_LONG' })
    }

    if (!AUTH_TYPES.has(authType)) {
      errors.push({
        field: `items[${i}].authType`,
        message: `Auth type must be one of local, saml, samlGroup (got "${authType}").`,
        code: 'INVALID_AUTH_TYPE',
      })
    }

    if (status && !ACCOUNT_STATUSES.has(status)) {
      errors.push({
        field: `items[${i}].status`,
        message: `Status must be enabled or disabled (got "${status}").`,
        code: 'INVALID_STATUS',
      })
    }

    if (description.length > MAX_DESCRIPTION) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION} characters or fewer (got ${description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
