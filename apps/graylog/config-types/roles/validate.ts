import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { parsePermissions } from './_shared'

/** Names Graylog reserves for its built-in, read-only roles. */
const BUILT_IN_ROLE_NAMES = new Set(['Admin', 'Reader'])

/**
 * Validate role items: a non-empty name (the identity — a duplicate is
 * flagged, last one wins) that is not one of Graylog's built-in read-only role
 * names ("Admin", "Reader" — Graylog rejects updating or deleting them), and a
 * well-formed `permissions` JSON array (empty is valid but useless — warned).
 * Static — no target access.
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
    const name = asString(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    } else if (BUILT_IN_ROLE_NAMES.has(name)) {
      errors.push({ field: `items[${i}].name`, message: `"${name}" is a built-in Graylog role and cannot be managed here (read-only).`, code: 'BUILT_IN_ROLE' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Role name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    const { permissions, error } = parsePermissions(item.fields.permissions)
    if (error) {
      errors.push({ field: `items[${i}].permissions`, message: error, code: 'INVALID_PERMISSIONS_JSON' })
    } else if (permissions.length === 0) {
      warnings.push({ field: `items[${i}].permissions`, message: 'No permissions declared — this role grants nothing.', code: 'EMPTY_PERMISSIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
