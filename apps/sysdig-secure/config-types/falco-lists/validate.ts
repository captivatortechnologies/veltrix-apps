import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { splitItems } from './_shared'

/**
 * Validate Falco-list items: a non-empty unique name and at least one item.
 * Static — no target access required. The list name is the stable identity, so a
 * duplicate name is flagged (last one wins on deploy).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Falco list.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const listItems = splitItems(item.fields.items)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'List name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `List name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (listItems.length === 0) {
      errors.push({ field: `items[${i}].items`, message: 'A list must contain at least one item.', code: 'EMPTY_ITEMS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
