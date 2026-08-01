import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'

/**
 * Validate group items: a non-empty group name with no '/' (top-level groups only;
 * a '/' would imply a sub-group path, which this config type does not author).
 * Static (no target access). The name is the identity, so a duplicate is flagged.
 */
const GROUP_NAME_RE = /^[^/]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_GROUP_NAME' })
    } else if (!GROUP_NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: `Group name "${name}" must not contain '/'. Sub-groups are not authored here.`,
        code: 'INVALID_GROUP_NAME',
      })
    } else if (seen.has(name)) {
      warnings.push({
        field: `items[${i}].name`,
        message: `Group name ${name} is listed more than once; the last one wins.`,
        code: 'DUPLICATE_GROUP_NAME',
      })
    } else {
      seen.add(name)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
