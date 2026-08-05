import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildRoleRecord } from './_shared'

/**
 * Validate role items: a non-empty name and description (SOAR requires both on
 * every role). Static — no target access required. Name is the role identity,
 * so a duplicate is flagged (last one wins, matching deploy's upsert order).
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
    const spec = buildRoleRecord(item.fields)
    if (!spec.id) {
      errors.push({ field: `items[${i}].name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
      return
    }
    const description = String(item.fields.description ?? '').trim()
    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Role description is required.', code: 'EMPTY_DESCRIPTION' })
    }
    const key = spec.id.toLowerCase()
    if (seen.has(key)) {
      warnings.push({ field: `items[${i}].name`, message: `Role name "${spec.id}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
