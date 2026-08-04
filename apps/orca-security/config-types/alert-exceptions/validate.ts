import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate alert-exception items: a non-empty rule_id (the identity — a
 * built-in Orca alert's catalog id, not something this app assigns). Static —
 * no target access required. A duplicate rule_id is flagged (last one wins,
 * since two items targeting the same rule would just fight over its state).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one alert exception.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const ruleId = String(item.fields.ruleId ?? '').trim()

    if (!ruleId) {
      errors.push({ field: `items[${i}].ruleId`, message: 'Rule ID is required — copy it from the Orca Alert Catalog.', code: 'EMPTY_RULE_ID' })
    } else if (seen.has(ruleId)) {
      warnings.push({
        field: `items[${i}].ruleId`,
        message: `Rule ID "${ruleId}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_RULE_ID',
      })
    } else {
      seen.add(ruleId)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
