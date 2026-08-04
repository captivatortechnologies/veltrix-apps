import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toStringList } from './_shared'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Validate user items: a non-empty first name and a well-formed, unique email.
 * Static — no target access required. Email is the identity, so a duplicate is
 * flagged (last one wins). A user with no roles is allowed but warned (they can
 * sign in but access very little).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const email = String(item.fields.email ?? '').trim()
    const firstName = String(item.fields.firstName ?? '').trim()

    if (!email) {
      errors.push({ field: `items[${i}].email`, message: 'Email is required.', code: 'EMPTY_EMAIL' })
    } else if (!EMAIL_RE.test(email)) {
      errors.push({ field: `items[${i}].email`, message: 'Email must be a valid email address.', code: 'INVALID_EMAIL' })
    } else {
      const key = email.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].email`,
          message: `Email "${email}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_EMAIL',
        })
      } else {
        seen.add(key)
      }
    }

    if (!firstName) {
      errors.push({ field: `items[${i}].firstName`, message: 'First name is required.', code: 'EMPTY_FIRST_NAME' })
    }

    if (toStringList(item.fields.roleIds).length === 0) {
      warnings.push({
        field: `items[${i}].roleIds`,
        message: `User "${email || i}" has no roles assigned — they can sign in but access very little.`,
        code: 'NO_ROLES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
