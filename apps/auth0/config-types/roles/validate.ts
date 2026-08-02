import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { parsePermissionLine } from './_shared'

/**
 * Validate Auth0 role items: a non-empty name (Auth0 forbids `<`/`>`), and — for
 * each non-blank permissions line — a parseable `<api-identifier>|<permission>`
 * grant. Static — no target access required. The role name is the upsert identity,
 * so a duplicate name is flagged (last one wins).
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
    const name = readString(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    } else {
      if (/[<>]/.test(name)) {
        errors.push({ field: `items[${i}].name`, message: `Role name "${name}" must not contain < or >.`, code: 'INVALID_NAME' })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Role name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    const raw = item.fields.permissions
    const lines = typeof raw === 'string' ? raw.split(/[\r\n]+/) : []
    lines.forEach((line) => {
      if (!line.trim()) return
      if (!parsePermissionLine(line)) {
        errors.push({
          field: `items[${i}].permissions`,
          message: `Permission "${line.trim()}" must be "<api-identifier>|<permission-name>" (a space also separates them).`,
          code: 'INVALID_PERMISSION',
        })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
