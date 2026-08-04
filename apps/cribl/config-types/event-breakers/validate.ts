import type { PipelineContext, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { EVENT_BREAKER, buildEventBreakerRecord } from './_shared'

/**
 * Validate Event Breaker Ruleset items — a non-empty id and `rules` that parse
 * to a non-empty JSON array. Static. Adds a warning (beyond the shared
 * validateRecords checks) when a ruleset has zero rules — it would break every
 * event on its `minRawLength` fallback rather than never being reached.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const result = validateRecords(ctx, EVENT_BREAKER, buildEventBreakerRecord)
  const warnings: ValidationWarning[] = [...result.warnings]
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  items.forEach((item, i) => {
    const spec = buildEventBreakerRecord(item.fields, ctx.settings ?? {})
    if (spec.body && Array.isArray(spec.body.rules) && spec.body.rules.length === 0) {
      warnings.push({ field: `items[${i}].rules`, message: `Event Breaker Ruleset ${spec.id} has no rules.`, code: 'EMPTY_RULES' })
    }
  })
  return { ...result, warnings }
}
