import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  KNOWN_MONITOR_TYPES,
  MAX_NAME_LENGTH,
  MAX_PRIORITY,
  MIN_PRIORITY,
  isJsonObject,
  extractMonitorSpecs,
  monitorKey,
  parseJsonObject,
  parsePriority,
  type MonitorSpec,
} from './_shared'

const NUMERIC_OPTION_KEYS = [
  'no_data_timeframe',
  'renotify_interval',
  'renotify_occurrences',
  'timeout_h',
  'new_group_delay',
  'evaluation_delay',
] as const
const BOOLEAN_OPTION_KEYS = ['notify_no_data', 'notify_audit', 'include_tags', 'require_full_window'] as const

/**
 * Validate Monitor items — static, no network access.
 *   - name, type, query are required.
 *   - type is checked against the well-documented common set as a WARNING
 *     only (see _shared.ts for why this is not a hard enum).
 *   - priority, when set, must be an integer 1-5.
 *   - options, when set, must parse as a JSON object; its well-documented
 *     numeric/boolean sub-fields are type-checked when present; thresholds /
 *     threshold_windows, when present, must be JSON objects (their own
 *     sub-values depend on the monitor's query/type and are not enumerable,
 *     so are not further validated — Datadog's API is the final arbiter).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Monitor.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractMonitorSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors, warnings)
    if (spec.name) {
      const key = monitorKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate monitor name "${spec.name}" — each name may only be declared once (monitors are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: MonitorSpec, i: number, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Monitor name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Monitor name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (!spec.type) {
    errors.push({ field: `${prefix}.type`, message: 'Monitor type is required.', code: 'EMPTY_TYPE' })
  } else if (!KNOWN_MONITOR_TYPES.includes(spec.type as (typeof KNOWN_MONITOR_TYPES)[number])) {
    warnings.push({
      field: `${prefix}.type`,
      message: `"${spec.type}" is not one of this app's well-documented monitor types (${KNOWN_MONITOR_TYPES.join(', ')}) — Datadog's own API will reject it if it is not a valid type.`,
      code: 'UNRECOGNIZED_TYPE',
    })
  }

  if (!spec.query) {
    errors.push({ field: `${prefix}.query`, message: 'Query is required.', code: 'EMPTY_QUERY' })
  }

  if (spec.priorityRaw) {
    const priority = parsePriority(spec.priorityRaw)
    if (priority === undefined) {
      // blank — fine, no priority set
    } else if (Number.isNaN(priority) || !Number.isInteger(priority) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
      errors.push({
        field: `${prefix}.priority`,
        message: `Priority must be an integer between ${MIN_PRIORITY} and ${MAX_PRIORITY} (got "${spec.priorityRaw}").`,
        code: 'INVALID_PRIORITY',
      })
    }
  }

  if (!spec.optionsRaw) return // optional
  const parsed = parseJsonObject(spec.optionsRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.options`, message: 'Options must be a valid JSON object.', code: 'INVALID_OPTIONS_JSON' })
    return
  }
  const opts = parsed.value
  if (!opts) return

  for (const key of NUMERIC_OPTION_KEYS) {
    if (key in opts && typeof opts[key] !== 'number') {
      errors.push({ field: `${prefix}.options.${key}`, message: `options.${key} must be a number.`, code: 'INVALID_OPTION_TYPE' })
    }
  }
  for (const key of BOOLEAN_OPTION_KEYS) {
    if (key in opts && typeof opts[key] !== 'boolean') {
      errors.push({ field: `${prefix}.options.${key}`, message: `options.${key} must be a boolean.`, code: 'INVALID_OPTION_TYPE' })
    }
  }
  if ('thresholds' in opts && !isJsonObject(opts.thresholds)) {
    errors.push({ field: `${prefix}.options.thresholds`, message: 'options.thresholds must be a JSON object.', code: 'INVALID_OPTION_TYPE' })
  }
  if ('threshold_windows' in opts && !isJsonObject(opts.threshold_windows)) {
    errors.push({ field: `${prefix}.options.threshold_windows`, message: 'options.threshold_windows must be a JSON object.', code: 'INVALID_OPTION_TYPE' })
  }
}
