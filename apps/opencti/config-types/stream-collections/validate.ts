import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate stream collection items: a non-empty name; description, filters,
 * origin_filters and the two boolean toggles are optional. `filters` and
 * `origin_filters` must be valid JSON when present (passed through verbatim —
 * not deep-validated). Static — no target access required. The name doubles
 * as the stream identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one stream collection.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Stream collection name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Stream collection "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    const filters = String(item.fields.filters ?? '').trim()
    if (filters) {
      try {
        JSON.parse(filters)
      } catch {
        errors.push({
          field: `items[${i}].filters`,
          message: 'Filters must be a valid JSON-encoded OpenCTI FilterGroup string.',
          code: 'INVALID_FILTERS_JSON',
        })
      }
    }

    const originFilters = String(item.fields.origin_filters ?? '').trim()
    if (originFilters) {
      try {
        JSON.parse(originFilters)
      } catch {
        errors.push({
          field: `items[${i}].origin_filters`,
          message: 'Origin filters must be a valid JSON-encoded string.',
          code: 'INVALID_ORIGIN_FILTERS_JSON',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
