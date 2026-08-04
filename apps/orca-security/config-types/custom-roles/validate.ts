import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeStringList } from '../../lib/reconcile'

/**
 * Validate custom-role items: a non-empty name (the identity), a non-empty
 * description (required by the API) and at least one permission group.
 * Static — no target access required. A duplicate name is flagged (last one
 * wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const description = String(item.fields.description ?? '').trim()
    const permissionGroups = normalizeStringList(item.fields.permissionGroups)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Role name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Description is required by the Orca API.', code: 'EMPTY_DESCRIPTION' })
    }

    if (permissionGroups.length === 0) {
      errors.push({ field: `items[${i}].permissionGroups`, message: 'At least one permission group is required.', code: 'EMPTY_PERMISSIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
