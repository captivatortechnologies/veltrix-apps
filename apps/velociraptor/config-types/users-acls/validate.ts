import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { KNOWN_ROLES, parseRoles } from './_shared'

/**
 * Validate users-acls items: each needs a name (identity) and at least one role.
 * Static — no target access required. The name is the upsert identity, so a
 * duplicate name is flagged (last one wins). Roles outside the well-known set are
 * warned (not rejected) — the role set can vary by deployment.
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
  })

  return { valid: errors.length === 0, errors, warnings }
}
