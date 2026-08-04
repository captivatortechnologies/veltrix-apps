import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { OUTCOME_CATEGORIES } from './_shared'

/**
 * Validate assignment-outcome items. Static — no target access required.
 *   - title is required and doubles as the identity (duplicates warned).
 *   - category must be one of the three fixed resolution buckets.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one assignment outcome.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = String(item.fields.title ?? '').trim()
    const category = String(item.fields.category ?? '').trim()

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!category) {
      errors.push({ field: `items[${i}].category`, message: 'Category is required.', code: 'EMPTY_CATEGORY' })
    } else if (!OUTCOME_CATEGORIES.has(category)) {
      errors.push({ field: `items[${i}].category`, message: `Category "${category}" is not one of ${[...OUTCOME_CATEGORIES].join(', ')}.`, code: 'INVALID_CATEGORY' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
