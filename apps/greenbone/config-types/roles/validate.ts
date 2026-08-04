import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PREDEFINED_ROLE_NAMES } from './_shared'

/**
 * Validate role items: a non-empty name that does not collide with one of the
 * 7 predefined/protected role names. Static — no gvmd access required. Role
 * names double as the upsert identity, so a duplicate name is flagged (last
 * one wins).
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
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
    } else if (PREDEFINED_ROLE_NAMES.has(name)) {
      errors.push({ field: `items[${i}].name`, message: `"${name}" is a predefined Greenbone role and cannot be created/modified/deleted through this app.`, code: 'PREDEFINED_ROLE' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Role name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
