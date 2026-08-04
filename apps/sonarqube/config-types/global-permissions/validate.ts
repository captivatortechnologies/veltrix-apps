import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parsePermissions } from './_shared'

/**
 * Validate global-permission items: a non-empty group name (the identity, so a duplicate is
 * flagged) and a permissions list that parses to at least one recognized permission. Static —
 * no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group grant.', code: 'EMPTY' })
  }

  const seen = new Set<string>()

  items.forEach((item, i) => {
    const groupName = String(item.fields.groupName ?? '').trim()

    if (!groupName) {
      errors.push({ field: `items[${i}].groupName`, message: 'Group name is required.', code: 'EMPTY_GROUP' })
    } else if (seen.has(groupName)) {
      warnings.push({
        field: `items[${i}].groupName`,
        message: `Group "${groupName}" is listed more than once; the last one wins — merge the permission lists into a single item instead.`,
        code: 'DUPLICATE_GROUP',
      })
    } else {
      seen.add(groupName)
    }

    const { permissions, errors: parseErrors } = parsePermissions(item.fields.permissions)
    for (const pe of parseErrors) {
      errors.push({ field: `items[${i}].permissions`, message: pe.message, code: pe.code })
    }
    if (permissions.length === 0 && parseErrors.length === 0) {
      errors.push({ field: `items[${i}].permissions`, message: 'Add at least one permission (e.g. admin, scan).', code: 'EMPTY_PERMISSIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
