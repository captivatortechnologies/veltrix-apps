import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseText } from './_shared'

/**
 * Validate user items: a non-empty user_name (the upsert identity) and a
 * non-empty role_name. Static — no target access; the role_name is resolved
 * against the live role list (and can fail with a clear error) at deploy time,
 * matching the enforcement-sets action_name / roles data_scope_name precedent
 * in this app.
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
    const userName = parseText(item.fields.user_name)
    const roleName = parseText(item.fields.role_name)

    if (!userName) {
      errors.push({ field: `items[${i}].user_name`, message: 'User name is required.', code: 'EMPTY_USER_NAME' })
    }

    if (!roleName) {
      errors.push({ field: `items[${i}].role_name`, message: 'Role name is required.', code: 'EMPTY_ROLE_NAME' })
    }

    if (userName) {
      if (seen.has(userName)) {
        warnings.push({ field: `items[${i}].user_name`, message: `User "${userName}" is listed more than once; the last one wins.`, code: 'DUPLICATE_USER_NAME' })
      } else {
        seen.add(userName)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
