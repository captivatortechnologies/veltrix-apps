import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, BASE_ROLE_VALUES } from './_shared'

/**
 * Validate custom-repository-roles items: a non-empty org + name, a valid base
 * role, and a warning when no additional permissions are granted (the role
 * would be identical to its base role). Static — no target access required.
 * (org, name) is the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.org) {
      errors.push({ field: `items[${i}].org`, message: 'Organization is required.', code: 'EMPTY_ORG' })
    }
    if (!desired.name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    }

    if (desired.org && desired.name) {
      const key = `${desired.org.toLowerCase()}/${desired.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Role ${desired.org}/${desired.name} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_ROLE',
        })
      } else {
        seen.add(key)
      }
    }

    if (!BASE_ROLE_VALUES.includes(desired.baseRole as (typeof BASE_ROLE_VALUES)[number])) {
      errors.push({ field: `items[${i}].base_role`, message: `Base role must be one of ${BASE_ROLE_VALUES.join(', ')}.`, code: 'INVALID_BASE_ROLE' })
    }

    if (desired.permissions.length === 0) {
      warnings.push({
        field: `items[${i}].permissions`,
        message: 'No additional permissions are listed — this role grants exactly the base role, nothing more.',
        code: 'NO_ADDITIONAL_PERMISSIONS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
