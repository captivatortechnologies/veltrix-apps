import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { KNOWN_ROLES, KNOWN_PERMISSIONS, parseRoles, parsePermissions } from './_shared'

/** Minimum length for an authored basic-auth password (NIST SP 800-63B floor for
 *  user-chosen secrets). Velociraptor usernames are freeform (plain names, emails,
 *  or SSO subject identifiers — see the canvas helpText), so no name-format
 *  regex is applied beyond the existing non-empty check. */
const MIN_PASSWORD_LENGTH = 8

/**
 * Validate users-acls items: each needs a name (identity) and at least one role.
 * Static — no target access required. The name is the upsert identity, so a
 * duplicate name is flagged (last one wins). Roles outside the well-known set are
 * warned (not rejected) — the role set can vary by deployment. An authored
 * basic-auth password shorter than MIN_PASSWORD_LENGTH is rejected.
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
    const name = String(item.fields.name ?? '').trim()
    const roles = parseRoles(item.fields.roles)
    const password = String(item.fields.password ?? '')

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Username is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Username "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (roles.length === 0) {
      errors.push({ field: `items[${i}].roles`, message: 'At least one role is required.', code: 'EMPTY_ROLES' })
    } else {
      const unknown = roles.filter((r) => !KNOWN_ROLES.has(r.toLowerCase()))
      if (unknown.length > 0) {
        warnings.push({
          field: `items[${i}].roles`,
          message: `Role(s) not in the well-known set: ${unknown.join(', ')}. They are sent as-is — verify they exist on the target server.`,
          code: 'UNKNOWN_ROLE',
        })
      }
    }

    const customPermissions = parsePermissions(item.fields.customPermissions)
    if (customPermissions.length > 0) {
      const unknown = customPermissions.filter((p) => !KNOWN_PERMISSIONS.has(p.toLowerCase()))
      if (unknown.length > 0) {
        warnings.push({
          field: `items[${i}].customPermissions`,
          message: `Custom permission(s) not in the well-known ACL set: ${unknown.join(', ')}. They are sent as-is — verify they exist on the target server.`,
          code: 'UNKNOWN_PERMISSION',
        })
      }
    }

    if (password && password.length < MIN_PASSWORD_LENGTH) {
      errors.push({
        field: `items[${i}].password`,
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`,
        code: 'WEAK_PASSWORD',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
