import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { YES_NO } from './_shared'

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const YES_NO_FIELDS = [
  'disabled',
  'change_pw',
  'termsaccepted',
  'notify',
  'external_auth_required',
  'autoalert',
  'contactalert',
  'notification_daily',
  'notification_weekly',
  'notification_monthly',
] as const

/**
 * Validate user items: a valid email, a positive numeric organisation and role
 * ID, and every account-state field set to a known yes/no value. Static — no
 * target access required and no password/authkey field exists to validate (see
 * config-types/users/_shared.ts). The email doubles as the user identity, so a
 * duplicate email is flagged (last one wins).
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
    const orgId = item.fields.org_id
    const roleId = item.fields.role_id

    if (!email) {
      errors.push({ field: `items[${i}].email`, message: 'Email is required.', code: 'EMPTY_EMAIL' })
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.push({ field: `items[${i}].email`, message: `Email must look like a valid address (got "${email}").`, code: 'INVALID_EMAIL' })
    } else if (seen.has(email.toLowerCase())) {
      warnings.push({ field: `items[${i}].email`, message: `Email "${email}" is listed more than once; the last one wins.`, code: 'DUPLICATE_EMAIL' })
    } else {
      seen.add(email.toLowerCase())
    }

    if (orgId === undefined || orgId === '' || !Number.isFinite(Number(orgId)) || Number(orgId) <= 0) {
      errors.push({ field: `items[${i}].org_id`, message: 'Organisation ID must be a positive number.', code: 'INVALID_ORG_ID' })
    }

    if (roleId === undefined || roleId === '' || !Number.isFinite(Number(roleId)) || Number(roleId) <= 0) {
      errors.push({ field: `items[${i}].role_id`, message: 'Role ID must be a positive number.', code: 'INVALID_ROLE_ID' })
    }

    for (const key of YES_NO_FIELDS) {
      const value = String(item.fields[key] ?? '').trim()
      if (!YES_NO.has(value)) {
        errors.push({ field: `items[${i}].${key}`, message: `${key} must be yes or no (got "${value}").`, code: 'INVALID_YES_NO' })
      }
    }

    const nidsSid = item.fields.nids_sid
    if (nidsSid !== undefined && nidsSid !== '' && (!Number.isFinite(Number(nidsSid)) || Number(nidsSid) < 0)) {
      errors.push({ field: `items[${i}].nids_sid`, message: 'NIDS SID must be a non-negative number.', code: 'INVALID_NUMBER' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
