import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate group items: a non-empty group name (its identity). Static — no
 * target access required. A group's identity is its name, so a duplicate name is
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
    const name = String(item.fields.groupName ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].groupName`, message: 'Group name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (name.length > 255) {
      errors.push({ field: `items[${i}].groupName`, message: `Group name "${name}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    const key = name.toLowerCase()
    if (seen.has(key)) {
      warnings.push({
        field: `items[${i}].groupName`,
        message: `Group "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_GROUP',
      })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
