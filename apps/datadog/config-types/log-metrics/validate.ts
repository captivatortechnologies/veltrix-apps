import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  AGGREGATION_TYPES,
  MAX_ID_LENGTH,
  METRIC_ID_RE,
  extractLogMetricSpecs,
  isJsonObject,
  metricKey,
  parseJsonArray,
  type LogMetricSpec,
} from './_shared'

/**
 * Validate Log-Based Metric items — static, no network access.
 *   - id is required, <= 200 chars, a plausible metric name, and unique
 *     across the canvas (its the resource's actual identity, not just a
 *     display label).
 *   - aggregation_type must be "count" or "distribution"; "distribution"
 *     requires a Value Path.
 *   - group_by, when set, must parse as a JSON array of objects with a
 *     "path" string.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Log-Based Metric.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLogMetricSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors)
    if (spec.id) {
      const key = metricKey(spec.id)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].id`,
          message: `Duplicate metric id "${spec.id}" — each id may only be declared once (it is the metric's permanent identity).`,
          code: 'DUPLICATE_ID',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: LogMetricSpec, i: number, errors: ValidationError[]): void {
  const prefix = `items[${i}]`

  if (!spec.id) {
    errors.push({ field: `${prefix}.id`, message: 'Metric id is required.', code: 'EMPTY_ID' })
  } else if (spec.id.length > MAX_ID_LENGTH) {
    errors.push({ field: `${prefix}.id`, message: `Metric id must be ${MAX_ID_LENGTH} characters or fewer.`, code: 'ID_TOO_LONG' })
  } else if (!METRIC_ID_RE.test(spec.id)) {
    errors.push({
      field: `${prefix}.id`,
      message: 'Metric id must start with a letter and contain only letters, digits, "." and "_".',
      code: 'INVALID_ID',
    })
  }

  if (!AGGREGATION_TYPES.includes(spec.aggregationType as (typeof AGGREGATION_TYPES)[number])) {
    errors.push({
      field: `${prefix}.aggregation_type`,
      message: `Aggregation Type must be one of ${AGGREGATION_TYPES.join(', ')} (got "${spec.aggregationType}").`,
      code: 'INVALID_AGGREGATION_TYPE',
    })
  } else if (spec.aggregationType === 'distribution' && !spec.path) {
    errors.push({ field: `${prefix}.path`, message: 'Value Path is required when Aggregation Type is "distribution".', code: 'EMPTY_PATH' })
  }

  if (!spec.groupByRaw) return
  const parsed = parseJsonArray(spec.groupByRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.group_by`, message: 'Group By must be a valid JSON array.', code: 'INVALID_GROUP_BY_JSON' })
    return
  }
  parsed.value?.forEach((g, gi) => {
    if (!isJsonObject(g)) {
      errors.push({ field: `${prefix}.group_by[${gi}]`, message: 'Each Group By entry must be a JSON object.', code: 'INVALID_GROUP_BY_ENTRY' })
      return
    }
    if (typeof g.path !== 'string' || !g.path.trim()) {
      errors.push({ field: `${prefix}.group_by[${gi}].path`, message: 'Each Group By entry needs a "path".', code: 'EMPTY_GROUP_BY_PATH' })
    }
  })
}
