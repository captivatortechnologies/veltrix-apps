import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  MAX_NAME_LENGTH,
  MODELED_SLO_TYPES,
  SLO_TYPES,
  TIMEFRAMES,
  extractSloSpecs,
  isJsonObject,
  parseJsonArray,
  parseMonitorIds,
  sloKey,
  type SloSpec,
} from './_shared'

/**
 * Validate SLO items — static, no network access.
 *   - name and type are required; name unique across the canvas.
 *   - type "metric" requires both Numerator and Denominator.
 *   - type "monitor" requires at least one Monitor ID (each a plain integer).
 *   - type "time_slice" is accepted but not deep-validated (see _shared.ts).
 *   - thresholds is required, must parse as a non-empty JSON array; each
 *     entry needs a supported "timeframe" and a numeric "target".
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one SLO.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSloSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors, warnings)
    if (spec.name) {
      const key = sloKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate SLO name "${spec.name}" — each name may only be declared once (SLOs are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: SloSpec, i: number, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'SLO name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `SLO name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (!SLO_TYPES.includes(spec.type as (typeof SLO_TYPES)[number])) {
    errors.push({ field: `${prefix}.type`, message: `Type must be one of ${SLO_TYPES.join(', ')} (got "${spec.type}").`, code: 'INVALID_TYPE' })
    return
  }

  if (spec.type === 'metric') {
    if (!spec.numerator) errors.push({ field: `${prefix}.numerator`, message: 'Numerator Query is required for a "metric" SLO.', code: 'EMPTY_NUMERATOR' })
    if (!spec.denominator) errors.push({ field: `${prefix}.denominator`, message: 'Denominator Query is required for a "metric" SLO.', code: 'EMPTY_DENOMINATOR' })
  } else if (spec.type === 'monitor') {
    const { ids, ok } = parseMonitorIds(spec.monitorIdsRaw)
    if (!ok) {
      errors.push({ field: `${prefix}.monitor_ids`, message: 'Monitor IDs must be plain integers.', code: 'INVALID_MONITOR_IDS' })
    } else if (ids.length === 0) {
      errors.push({ field: `${prefix}.monitor_ids`, message: 'At least one Monitor ID is required for a "monitor" SLO.', code: 'EMPTY_MONITOR_IDS' })
    }
  } else if (!MODELED_SLO_TYPES.has(spec.type)) {
    warnings.push({
      field: `${prefix}.type`,
      message: `"${spec.type}" SLOs are accepted but not deep-validated by this app — Datadog's own API validates the rest of the body.`,
      code: 'UNMODELED_TYPE',
    })
  }

  if (!spec.thresholdsRaw) {
    errors.push({ field: `${prefix}.thresholds`, message: 'Thresholds is required — at least one JSON object.', code: 'EMPTY_THRESHOLDS' })
    return
  }
  const parsed = parseJsonArray(spec.thresholdsRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.thresholds`, message: 'Thresholds must be a valid JSON array.', code: 'INVALID_THRESHOLDS_JSON' })
    return
  }
  if (!parsed.value || parsed.value.length === 0) {
    errors.push({ field: `${prefix}.thresholds`, message: 'At least one threshold is required.', code: 'EMPTY_THRESHOLDS' })
    return
  }
  parsed.value.forEach((t, ti) => {
    if (!isJsonObject(t)) {
      errors.push({ field: `${prefix}.thresholds[${ti}]`, message: 'Each threshold must be a JSON object.', code: 'INVALID_THRESHOLD' })
      return
    }
    if (!TIMEFRAMES.includes(t.timeframe as (typeof TIMEFRAMES)[number])) {
      errors.push({
        field: `${prefix}.thresholds[${ti}].timeframe`,
        message: `Threshold timeframe must be one of ${TIMEFRAMES.join(', ')} (got "${String(t.timeframe)}").`,
        code: 'INVALID_TIMEFRAME',
      })
    }
    if (typeof t.target !== 'number') {
      errors.push({ field: `${prefix}.thresholds[${ti}].target`, message: 'Threshold target must be a number.', code: 'INVALID_TARGET' })
    }
  })
}
