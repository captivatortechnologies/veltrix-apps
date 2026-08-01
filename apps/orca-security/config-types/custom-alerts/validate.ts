import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { CATEGORIES, MIN_SCORE, MAX_SCORE } from './_shared'

/**
 * Validate custom-alert items: a non-empty name, a non-empty Sonar query, a
 * known category and a score in range. Static — no target access required. The
 * name is the human identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom alert.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const category = String(item.fields.category ?? '').trim()
    const rule = String(item.fields.rule ?? '').trim()
    const rawScore = item.fields.orcaScore

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Alert name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Alert name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!rule) {
      errors.push({ field: `items[${i}].rule`, message: 'A Sonar query is required.', code: 'EMPTY_RULE' })
    }

    if (!CATEGORIES.has(category)) {
      errors.push({
        field: `items[${i}].category`,
        message: `Category must be one of the Orca alert categories (got "${category}").`,
        code: 'INVALID_CATEGORY',
      })
    }

    const score = typeof rawScore === 'number' ? rawScore : Number(String(rawScore ?? '').trim())
    if (rawScore === undefined || rawScore === null || rawScore === '' || !Number.isFinite(score)) {
      errors.push({ field: `items[${i}].orcaScore`, message: 'A numeric risk score is required.', code: 'EMPTY_SCORE' })
    } else if (score < MIN_SCORE || score > MAX_SCORE) {
      errors.push({
        field: `items[${i}].orcaScore`,
        message: `Risk score must be between ${MIN_SCORE} and ${MAX_SCORE} (got ${score}).`,
        code: 'INVALID_SCORE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
