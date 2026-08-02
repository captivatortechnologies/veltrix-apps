import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_PATTERN, readAttributes } from './_shared'

/**
 * Validate authentik Group items: a non-empty name (the upsert identity —
 * groups have no user-declared path key), a valid-UUID parent when set, and
 * parseable attributes. Static (no target access): the parent pk is not
 * resolved against a live authentik instance here. A duplicate name is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const parent = String(item.fields.parent ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Group name "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(name)
    }

    if (parent && !UUID_PATTERN.test(parent)) {
      errors.push({ field: `items[${i}].parent`, message: `"${parent}" is not a valid UUID.`, code: 'INVALID_PARENT' })
    }

    const rawAttributes = item.fields.attributes
    if (typeof rawAttributes === 'string' && rawAttributes.trim() && Object.keys(readAttributes(rawAttributes)).length === 0) {
      warnings.push({
        field: `items[${i}].attributes`,
        message: 'Attributes could not be parsed as key=value pairs.',
        code: 'UNPARSEABLE_ATTRIBUTES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
