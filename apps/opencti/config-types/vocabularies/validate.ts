import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { VOCABULARY_CATEGORIES } from './_shared'

/**
 * Validate vocabulary items: a known `VocabularyCategory`, a non-empty name and
 * an optional non-negative integer order. Static — no target access required.
 * `category` + `name` together are the compound identity, so a duplicate PAIR
 * is flagged (last one wins) — the same name may legitimately repeat across
 * different categories.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one vocabulary entry.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const category = String(item.fields.category ?? '').trim()
    const name = String(item.fields.name ?? '').trim()
    const orderRaw = item.fields.order

    if (!VOCABULARY_CATEGORIES.has(category)) {
      errors.push({
        field: `items[${i}].category`,
        message: `Category "${category}" is not a recognized OpenCTI vocabulary category.`,
        code: 'INVALID_CATEGORY',
      })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Vocabulary name is required.', code: 'EMPTY_NAME' })
    }

    if (category && name) {
      const key = `${category.toLowerCase()}::${name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Category "${category}" name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_VOCABULARY',
        })
      } else {
        seen.add(key)
      }
    }

    if (orderRaw !== undefined && orderRaw !== null && orderRaw !== '') {
      const order = Number(orderRaw)
      if (!Number.isFinite(order) || order < 0 || !Number.isInteger(order)) {
        errors.push({
          field: `items[${i}].order`,
          message: `Order "${String(orderRaw)}" must be a non-negative integer.`,
          code: 'INVALID_ORDER',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
