import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toRetentionDays } from './_shared'

const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Validate scheduled-view items: a non-empty index name, query and RFC3339 start
 * time. Static — no target access required. The index name is the identity, so a
 * duplicate name is flagged (last one wins). `query`/`startTime` are only applied
 * at creation — editing them on an existing view is warned about since Sumo Logic
 * silently ignores them on update (surfaced by drift instead).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one scheduled view.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const indexName = String(item.fields.indexName ?? '').trim()
    const query = String(item.fields.query ?? '').trim()
    const startTime = String(item.fields.startTime ?? '').trim()

    if (!indexName) {
      errors.push({ field: `items[${i}].indexName`, message: 'Index name is required.', code: 'EMPTY_INDEX_NAME' })
    } else {
      const key = indexName.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].indexName`,
          message: `Index name "${indexName}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_INDEX_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!query) {
      errors.push({ field: `items[${i}].query`, message: 'Query is required.', code: 'EMPTY_QUERY' })
    }

    if (!startTime) {
      errors.push({ field: `items[${i}].startTime`, message: 'Start time is required (RFC3339, e.g. 2026-01-01T00:00:00Z).', code: 'EMPTY_START_TIME' })
    } else if (!RFC3339_RE.test(startTime)) {
      errors.push({
        field: `items[${i}].startTime`,
        message: 'Start time must be RFC3339, e.g. 2026-01-01T00:00:00Z.',
        code: 'INVALID_START_TIME',
      })
    }

    const rawRetention = item.fields.retentionPeriod
    if (rawRetention !== '' && rawRetention !== null && rawRetention !== undefined) {
      const days = toRetentionDays(rawRetention)
      if (days === undefined || days < -1) {
        errors.push({
          field: `items[${i}].retentionPeriod`,
          message: 'Retention period must be a whole number of days >= -1 (-1 = account default).',
          code: 'INVALID_RETENTION',
        })
      }
    }

    const parsingMode = String(item.fields.parsingMode ?? '').trim()
    if (parsingMode && parsingMode !== 'AutoParse' && parsingMode !== 'Manual') {
      errors.push({ field: `items[${i}].parsingMode`, message: 'Parsing mode must be AutoParse or Manual.', code: 'INVALID_PARSING_MODE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
