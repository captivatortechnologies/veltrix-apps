import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  CORRELATION_SEVERITIES,
  EXECUTION_MODES,
  DRILLDOWN_TIMEFRAMES,
  MAPPING_STRATEGIES,
} from './_shared'

/**
 * Validate correlation-rule items: a non-empty name, a non-empty XQL query, a
 * known severity + execution mode, and — when provided — a known drilldown
 * timeframe / mapping strategy. Static — no target access required. The name
 * doubles as the rule's identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one correlation rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const xqlQuery = String(item.fields.xql_query ?? '').trim()
    const severity = String(item.fields.severity ?? '').trim()
    const executionMode = String(item.fields.execution_mode ?? '').trim() || 'SCHEDULED'
    const drilldown = String(item.fields.drilldown_query_timeframe ?? '').trim()
    const mappingStrategy = String(item.fields.mapping_strategy ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Rule "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!xqlQuery) {
      errors.push({ field: `items[${i}].xql_query`, message: 'XQL query is required.', code: 'EMPTY_XQL_QUERY' })
    }

    if (!CORRELATION_SEVERITIES.has(severity)) {
      errors.push({ field: `items[${i}].severity`, message: `Severity must be one of ${[...CORRELATION_SEVERITIES].join(', ')} (got "${severity}").`, code: 'INVALID_SEVERITY' })
    }

    if (!EXECUTION_MODES.has(executionMode)) {
      errors.push({ field: `items[${i}].execution_mode`, message: `Execution mode must be one of ${[...EXECUTION_MODES].join(', ')} (got "${executionMode}").`, code: 'INVALID_EXECUTION_MODE' })
    }

    if (drilldown && !DRILLDOWN_TIMEFRAMES.has(drilldown)) {
      errors.push({ field: `items[${i}].drilldown_query_timeframe`, message: `Drilldown timeframe must be one of ${[...DRILLDOWN_TIMEFRAMES].join(', ')} (got "${drilldown}").`, code: 'INVALID_DRILLDOWN_TIMEFRAME' })
    }

    if (mappingStrategy && !MAPPING_STRATEGIES.has(mappingStrategy)) {
      errors.push({ field: `items[${i}].mapping_strategy`, message: `Mapping strategy must be one of ${[...MAPPING_STRATEGIES].join(', ')} (got "${mappingStrategy}").`, code: 'INVALID_MAPPING_STRATEGY' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
