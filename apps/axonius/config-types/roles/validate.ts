import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseText, parseBool, parsePermissions } from './_shared'

/**
 * Validate role items: a non-empty name (the upsert identity), permissions that
 * parse to a JSON object, and — when the data-scope restriction is enabled — a
 * non-empty data-scope name. Static — no target access; the permission
 * category/action names and the data-scope name are tenant-specific and
 * resolved (and can fail) at deploy time, matching the enforcement-sets
 * action_name precedent in this app.
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
    const name = parseText(item.fields.name)
    const dataScopeEnabled = parseBool(item.fields.data_scope_enabled)
    const dataScopeName = parseText(item.fields.data_scope_name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    }

    const permissions = parsePermissions(item.fields.permissions)
    if (!permissions.ok) {
      errors.push({ field: `items[${i}].permissions`, message: `Permissions must be a valid JSON object: ${permissions.error}`, code: 'INVALID_PERMISSIONS' })
    } else if (Object.keys(permissions.value).length === 0) {
      warnings.push({ field: `items[${i}].permissions`, message: `Role "${name || i}" has an empty permission set — it will have no access to anything.`, code: 'EMPTY_PERMISSIONS' })
    }

    if (dataScopeEnabled && !dataScopeName) {
      errors.push({
        field: `items[${i}].data_scope_name`,
        message: `Role "${name || i}" enables a data-scope restriction but does not name a data scope.`,
        code: 'MISSING_DATA_SCOPE_NAME',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Role "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
