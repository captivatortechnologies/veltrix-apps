import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { FILTERED_DATA_TYPES, MAX_NAME_LENGTH, extractSecurityFilterSpecs, isJsonObject, parseJsonArray, securityFilterKey, type SecurityFilterSpec } from './_shared'

/**
 * Validate Security Filter items — static, no network access.
 *   - name and query are required; name unique across the canvas.
 *   - filtered_data_type must be "logs" (the only documented value).
 *   - exclusion_filters, when set, must parse as a JSON array of objects with
 *     "name" and "query" strings.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Security Filter.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSecurityFilterSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.name) {
      const key = securityFilterKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate filter name "${spec.name}" — each name may only be declared once (filters are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: SecurityFilterSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Filter name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Filter name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (!spec.query) {
    errors.push({ field: `${prefix}.query`, message: 'Query is required.', code: 'EMPTY_QUERY' })
  }

  if (!FILTERED_DATA_TYPES.includes(spec.filteredDataType as (typeof FILTERED_DATA_TYPES)[number])) {
    errors.push({
      field: `${prefix}.filtered_data_type`,
      message: `Filtered Data Type must be one of ${FILTERED_DATA_TYPES.join(', ')} (got "${spec.filteredDataType}").`,
      code: 'INVALID_DATA_TYPE',
    })
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
    if (typeof f.query !== 'string' || !f.query.trim()) {
      errors.push({ field: `${prefix}.exclusion_filters[${fi}].query`, message: 'Each exclusion filter needs a "query".', code: 'EMPTY_EXCLUSION_QUERY' })
    }
  })
}
