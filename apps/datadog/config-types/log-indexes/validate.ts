import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, extractLogIndexSpecs, indexKey, isJsonObject, parseJsonArray, parseOptionalNumber, type LogIndexSpec } from './_shared'

/**
 * Validate Log Index items — static, no network access.
 *   - name is required, <= 80 chars, unique across the canvas (it is the
 *     resource's actual identity, not just a display label).
 *   - num_retention_days / daily_limit, when set, must be non-negative
 *     numbers.
 *   - exclusion_filters, when set, must parse as a JSON array of objects
 *     with a "name".
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Log Index.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLogIndexSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = indexKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate index name "${spec.name}" — each name may only be declared once (it is the index's permanent identity).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: LogIndexSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Index name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Index name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (spec.retentionDaysRaw) {
    const n = parseOptionalNumber(spec.retentionDaysRaw)
    if (Number.isNaN(n) || (typeof n === 'number' && n < 0)) {
      errors.push({ field: `${prefix}.num_retention_days`, message: 'Retention (days) must be a non-negative number.', code: 'INVALID_RETENTION' })
    }
  }
  if (spec.dailyLimitRaw) {
    const n = parseOptionalNumber(spec.dailyLimitRaw)
    if (Number.isNaN(n) || (typeof n === 'number' && n < 0)) {
      errors.push({ field: `${prefix}.daily_limit`, message: 'Daily Limit must be a non-negative number.', code: 'INVALID_DAILY_LIMIT' })
    }
  }

  if (!spec.exclusionFiltersRaw) return
  const parsed = parseJsonArray(spec.exclusionFiltersRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.exclusion_filters`, message: 'Exclusion Filters must be a valid JSON array.', code: 'INVALID_EXCLUSION_FILTERS_JSON' })
    return
  }
  parsed.value?.forEach((f, fi) => {
    if (!isJsonObject(f)) {
      errors.push({ field: `${prefix}.exclusion_filters[${fi}]`, message: 'Each exclusion filter must be a JSON object.', code: 'INVALID_EXCLUSION_FILTER' })
      return
    }
    if (typeof f.name !== 'string' || !f.name.trim()) {
      errors.push({ field: `${prefix}.exclusion_filters[${fi}].name`, message: 'Each exclusion filter needs a "name".', code: 'EMPTY_EXCLUSION_NAME' })
    }
  })
}
