import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, specFromItem } from './_shared'

/**
 * Validate network device group items: a non-empty, uniquely-named group
 * within ERS's length limits. A name with no "#" is allowed (it creates a new
 * root category) but flagged as a warning since it's an easy typo to make when
 * a child group ("Root#Value") was intended.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network device group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const { name, description } = specFromItem(item)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `items[${i}].name`,
        message: `Group name must be ${MAX_NAME_LENGTH} characters or fewer (got ${name.length}).`,
        code: 'NAME_TOO_LONG',
      })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Group name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
      if (!name.includes('#')) {
        warnings.push({
          field: `items[${i}].name`,
          message: `"${name}" has no "#" — this creates a new ROOT category, not a child group. If you meant a child, use "Root#${name}" (e.g. "Location#${name}").`,
          code: 'ROOT_LEVEL_NAME',
        })
      }
    }

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
