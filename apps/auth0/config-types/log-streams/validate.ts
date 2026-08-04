import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonObject, readOptionalString, readString } from '../../lib/fields'
import { LOG_STREAM_STATUSES, LOG_STREAM_TYPES, parseJsonArray } from './_shared'

/**
 * Validate Auth0 log stream items: a non-empty name (100 chars or fewer), a
 * known sink type, a well-formed non-empty sink JSON object (httpEndpoint
 * required when the type is http), a known status, and — when present — a
 * well-formed JSON filters array of { type, name } category filters. Static:
 * no target access required. The stream name is the upsert identity, so a
 * duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one log stream.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = readString(item.fields.name)
    const type = readString(item.fields.type)
    const status = readOptionalString(item.fields.status) ?? ''

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Log stream name is required.', code: 'EMPTY_NAME' })
    } else {
      if (name.length > 100) {
        errors.push({ field: `items[${i}].name`, message: `Log stream name "${name}" must be 100 characters or fewer.`, code: 'INVALID_NAME' })
      }
      if (seen.has(name)) {
        warnings.push({ field: `items[${i}].name`, message: `Log stream name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(name)
      }
    }

    if (!LOG_STREAM_TYPES.has(type)) {
      errors.push({
        field: `items[${i}].type`,
        message: `Log stream type "${type}" is not one of the supported types (${[...LOG_STREAM_TYPES].join(', ')}).`,
        code: 'INVALID_TYPE',
      })
    }

    if (status && !LOG_STREAM_STATUSES.has(status)) {
      errors.push({
        field: `items[${i}].status`,
        message: `Log stream status must be one of ${[...LOG_STREAM_STATUSES].join(', ')} (got "${status}").`,
        code: 'INVALID_STATUS',
      })
    }

    const sink = parseJsonObject(item.fields.sink)
    if (!sink.ok) {
      errors.push({ field: `items[${i}].sink`, message: `Sink ${sink.error}.`, code: 'INVALID_SINK' })
    } else if (Object.keys(sink.value).length === 0) {
      errors.push({ field: `items[${i}].sink`, message: 'Sink configuration is required.', code: 'EMPTY_SINK' })
    } else if (type === 'http' && !readString(sink.value.httpEndpoint)) {
      errors.push({ field: `items[${i}].sink`, message: 'HTTP sinks require an httpEndpoint.', code: 'MISSING_HTTP_ENDPOINT' })
    }

    const filters = parseJsonArray(item.fields.filters)
    if (!filters.ok) {
      errors.push({ field: `items[${i}].filters`, message: `Filters ${filters.error}.`, code: 'INVALID_FILTERS' })
    } else {
      filters.value.forEach((entry, fi) => {
        const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null
        const category = record ? readString(record.type) : ''
        const categoryName = record ? readString(record.name) : ''
        if (!record || !category || !categoryName) {
          errors.push({
            field: `items[${i}].filters[${fi}]`,
            message: 'Each filter must be an object with a non-empty "type" and "name", e.g. {"type":"category","name":"auth.login.success"}.',
            code: 'INVALID_FILTER_ENTRY',
          })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
