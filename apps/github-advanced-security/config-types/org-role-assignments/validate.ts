import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem } from './_shared'

/**
 * Validate org-role-assignments items: a non-empty org, team and role name.
 * Static — no target access required (role names are resolved live at deploy
 * time, not validated against a hardcoded catalog). (org, team, role_name) is
 * the identity, so a duplicate is flagged (last one wins, though it is a
 * harmless no-op since assignment is idempotent).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one assignment.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.org) {
      errors.push({ field: `items[${i}].org`, message: 'Organization is required.', code: 'EMPTY_ORG' })
    }
    if (!desired.team) {
      errors.push({ field: `items[${i}].team`, message: 'Team slug is required.', code: 'EMPTY_TEAM' })
    }
    if (!desired.roleName) {
      errors.push({ field: `items[${i}].role_name`, message: 'Organization role is required.', code: 'EMPTY_ROLE_NAME' })
    }

    if (desired.org && desired.team && desired.roleName) {
      const key = `${desired.org.toLowerCase()}::${desired.team.toLowerCase()}::${desired.roleName.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].role_name`,
          message: `Assigning ${desired.roleName} to ${desired.team} on ${desired.org} is listed more than once.`,
          code: 'DUPLICATE_ASSIGNMENT',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
