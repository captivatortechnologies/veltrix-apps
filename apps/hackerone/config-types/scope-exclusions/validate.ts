import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { str } from './_shared'

/**
 * Validate scope-exclusion items: each needs a program handle and a non-empty
 * category name. Static — no target access required. Identity is
 * (program_handle + category), so a category repeated within the same program is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scope exclusion.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const programHandle = str(item.fields.program_handle)
    const category = str(item.fields.category)

    if (!programHandle) {
      errors.push({ field: `items[${i}].program_handle`, message: 'Program handle is required.', code: 'EMPTY_PROGRAM' })
    }

    if (!category) {
      errors.push({ field: `items[${i}].category`, message: 'Category is required.', code: 'EMPTY_CATEGORY' })
    } else if (programHandle) {
      const key = `${programHandle.toLowerCase()} ${category.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].category`,
          message: `Category "${category}" is listed more than once for program "${programHandle}"; the last one wins.`,
          code: 'DUPLICATE_CATEGORY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
