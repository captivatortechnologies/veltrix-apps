import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'

/**
 * Validate realm-role items: a non-empty role name with no whitespace. Static (no
 * target access). The role name is the identity AND the {role-name} path segment,
 * so a duplicate is flagged (last one wins).
 */
const ROLE_NAME_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one realm role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_ROLE_NAME' })
    } else if (!ROLE_NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Role name "${name}" must not contain whitespace.`,
        code: 'INVALID_ROLE_NAME',
      })
    } else if (seen.has(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Role name ${name} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_ROLE_NAME',
      })
    } else {
      seen.add(name)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
