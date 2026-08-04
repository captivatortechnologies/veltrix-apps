import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { text, readOrgRoles, KNOWN_ROLE_HINTS } from './_shared'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate User items: a non-empty, plausible email is required (it doubles as the identity).
 * Role values are checked against a small set of known hints and warned on (never blocked) — see
 * the ROLE VOCABULARY note in _shared.ts. Static — no target access required. A duplicate email
 * is flagged (last wins). Note the account-scope requirement is a deploy-time concern, surfaced by
 * healthCheck, not something validate can assert statically.
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
    const email = text(item.fields.email)

    if (!email) {
      errors.push({ field: `items[${i}].email`, message: 'Email is required.', code: 'EMPTY_EMAIL' })
    } else if (!EMAIL_RE.test(email)) {
      warnings.push({ field: `items[${i}].email`, message: `"${email}" does not look like a valid email address.`, code: 'SUSPECT_EMAIL' })
    } else if (seen.has(email.toLowerCase())) {
      warnings.push({
        field: `items[${i}].email`,
        message: `Email "${email}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_EMAIL',
      })
    } else {
      seen.add(email.toLowerCase())
    }

    if (item.fields.clientAdmin === true) {
      warnings.push({
        field: `items[${i}].clientAdmin`,
        message: `"${email || 'This user'}" is granted Client Admin (Superuser) — full account-wide access.`,
        code: 'CLIENT_ADMIN_GRANTED',
      })
    }

    const defaultRole = text(item.fields.orgDefaultRole)
    if (defaultRole && !(KNOWN_ROLE_HINTS as readonly string[]).includes(defaultRole.toLowerCase())) {
      warnings.push({
        field: `items[${i}].orgDefaultRole`,
        message: `Role "${defaultRole}" is not one of the commonly documented roles (${KNOWN_ROLE_HINTS.join(', ')}) — runZero may reject it.`,
        code: 'UNRECOGNIZED_ROLE',
      })
    }

    const orgRoles = readOrgRoles(item.fields.orgRoles)
    for (const [orgId, role] of Object.entries(orgRoles)) {
      if (role && !(KNOWN_ROLE_HINTS as readonly string[]).includes(role.toLowerCase())) {
        warnings.push({
          field: `items[${i}].orgRoles.${orgId}`,
          message: `Role "${role}" is not one of the commonly documented roles (${KNOWN_ROLE_HINTS.join(', ')}) — runZero may reject it.`,
          code: 'UNRECOGNIZED_ROLE',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
