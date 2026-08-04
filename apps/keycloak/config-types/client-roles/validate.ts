import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'

/**
 * Validate client-role items: a non-empty target clientId and a non-empty role
 * name with no whitespace. Static (no target access). Role names are only unique
 * WITHIN a client, so — unlike this app's other config types — a duplicate is
 * keyed on the composite (clientId, name) pair: two items with the same role
 * name under DIFFERENT clients are not a duplicate.
 */
const ROLE_NAME_RE = /^[^\s]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one client role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const clientId = readString(item.fields.clientId)
    const name = readString(item.fields.name)

    if (!clientId) {
      errors.push({ field: `items[${i}].clientId`, message: 'Client ID is required.', code: 'EMPTY_CLIENT_ID' })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_ROLE_NAME' })
    } else if (!ROLE_NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Role name "${name}" must not contain whitespace.`,
        code: 'INVALID_ROLE_NAME',
      })
    } else if (clientId) {
      const key = `${clientId}::${name}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Role name ${name} on client ${clientId} is listed more than once; the last one wins.`,
          code: 'DUPLICATE_ROLE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
