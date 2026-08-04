import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isValidJsonField } from './_shared'

const NAME_RE = /^[A-Za-z0-9 +%\-@.,_()]+$/
const PARSING_MODES = new Set(['AutoParse', 'Manual'])
const INTERVAL_TIME_TYPES = new Set(['messageTime', 'receiptTime', 'searchableTime'])

/**
 * Validate log-search items: a non-empty, Sumo-legal name, a non-empty query,
 * well-formed JSON for timeRange/queryParameters/schedule, and recognized
 * enum values. Static — no target access required. A duplicate (parentId,
 * name) pair is flagged, since a log search's name is only unique within its
 * folder.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one log search.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const parentId = String(item.fields.parentId ?? '').trim()
    const queryString = String(item.fields.queryString ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Log search name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_RE.test(name)) {
      errors.push({
        field: `items[${i}].name`,
        message: 'Name may only contain letters, numbers, spaces and + % - @ . , _ ( )',
        code: 'INVALID_NAME',
      })
    } else {
      const key = `${parentId.toLowerCase()}::${name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Log search "${name}" is listed more than once for the same folder; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!queryString) {
      errors.push({ field: `items[${i}].queryString`, message: 'Query is required.', code: 'EMPTY_QUERY' })
    }

    if (!isValidJsonField(item.fields.timeRange)) {
      errors.push({ field: `items[${i}].timeRange`, message: 'Time range must be well-formed JSON.', code: 'INVALID_TIME_RANGE_JSON' })
    }
    if (!isValidJsonField(item.fields.queryParameters)) {
      errors.push({ field: `items[${i}].queryParameters`, message: 'Search template parameters must be well-formed JSON.', code: 'INVALID_QUERY_PARAMETERS_JSON' })
    }
    if (!isValidJsonField(item.fields.schedule)) {
      errors.push({ field: `items[${i}].schedule`, message: 'Schedule must be well-formed JSON.', code: 'INVALID_SCHEDULE_JSON' })
    }

    const parsingMode = String(item.fields.parsingMode ?? '').trim()
    if (parsingMode && !PARSING_MODES.has(parsingMode)) {
      errors.push({ field: `items[${i}].parsingMode`, message: 'Parsing mode must be AutoParse or Manual.', code: 'INVALID_PARSING_MODE' })
    }

    const intervalTimeType = String(item.fields.intervalTimeType ?? '').trim()
    if (intervalTimeType && !INTERVAL_TIME_TYPES.has(intervalTimeType)) {
      errors.push({
        field: `items[${i}].intervalTimeType`,
        message: 'Interval time type must be messageTime, receiptTime or searchableTime.',
        code: 'INVALID_INTERVAL_TIME_TYPE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
