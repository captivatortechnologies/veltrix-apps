import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import {
  RULE_TYPES,
  STANDARD_QUERY_TYPES,
  CASE_STATUSES,
  QUERY_AGGREGATIONS,
  QUERY_DATA_SOURCES,
  DETECTION_METHODS,
  WINDOW_SECONDS,
  FILTER_ACTIONS,
  MAX_NAME_LENGTH,
  extractRuleSpecs,
  isJsonObject,
  parseJsonArray,
  parseJsonObject,
  ruleKey,
  type RuleSpec,
} from './_shared'

/**
 * Validate Datadog Security Monitoring Rule items — static, no network access.
 *
 *   - name (required, <= 255 chars, unique across the canvas) and message
 *     (required) are universal.
 *   - type must be one of the 5 documented rule types.
 *   - queries / cases must each be present and parse as a JSON array; options
 *     must parse as a JSON object; filters, if present, must parse as a JSON
 *     array.
 *   - For the "standard" types (log_detection / workload_security /
 *     application_security) this deep-validates the well-documented common
 *     shape: every query needs a non-empty "query" string and, when present,
 *     "aggregation" / "dataSource" must be a supported enum value; every case
 *     needs a supported "status"; options' evaluationWindow / keepAlive /
 *     maxSignalDuration / detectionMethod are enum-checked when present.
 *   - For signal_correlation and cloud_configuration — whose queries/options
 *     diverge structurally (rule references; a Rego compliance policy) — only
 *     the universal "cases[].status" and JSON-shape checks apply; Datadog's
 *     own API is the final arbiter of their type-specific sub-schemas.
 *   - cloud_configuration rules must declare exactly one case (Datadog
 *     requires this — a single finding severity for the whole rule).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Security Monitoring Rule.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors, warnings)

    if (spec.name) {
      const key = ruleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate rule name "${spec.name}" — each name may only be declared once (rules are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: RuleSpec, i: number, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({
      field: `${prefix}.name`,
      message: `Rule name must be ${MAX_NAME_LENGTH} characters or fewer.`,
      code: 'NAME_TOO_LONG',
    })
  }

  if (!spec.message) {
    errors.push({ field: `${prefix}.message`, message: 'Message is required (shown on every generated signal).', code: 'EMPTY_MESSAGE' })
  }

  if (!RULE_TYPES.includes(spec.type as (typeof RULE_TYPES)[number])) {
    errors.push({
      field: `${prefix}.type`,
      message: `Rule type must be one of ${RULE_TYPES.join(', ')} (got "${spec.type}").`,
      code: 'INVALID_TYPE',
    })
    // Without a known type there's no basis for the type-aware checks below.
    validateQueriesShapeOnly(spec, prefix, errors)
    validateCasesShapeOnly(spec, prefix, errors)
    validateOptionsShapeOnly(spec, prefix, errors)
    validateFilters(spec, prefix, errors)
    return
  }

  const isStandard = STANDARD_QUERY_TYPES.has(spec.type)
  const isCloudConfig = spec.type === 'cloud_configuration'

  // --- queries ---------------------------------------------------------------
  if (!spec.queriesRaw) {
    if (isCloudConfig) {
      warnings.push({
        field: `${prefix}.queries`,
        message: 'cloud_configuration rules usually declare an empty queries array ([]) — the policy lives in Options.',
        code: 'CLOUD_CONFIG_EMPTY_QUERIES',
      })
    } else {
      errors.push({ field: `${prefix}.queries`, message: 'Queries is required — at least a JSON array ([]).', code: 'EMPTY_QUERIES' })
    }
  } else {
    const parsed = parseJsonArray(spec.queriesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.queries`, message: 'Queries must be a valid JSON array.', code: 'INVALID_QUERIES_JSON' })
    } else if (parsed.value) {
      if (parsed.value.length === 0 && !isCloudConfig) {
        errors.push({ field: `${prefix}.queries`, message: 'At least one query is required.', code: 'EMPTY_QUERIES' })
      }
      if (isStandard) {
        parsed.value.forEach((q, qi) => validateStandardQuery(q, `${prefix}.queries[${qi}]`, errors))
      } else if (spec.type === 'signal_correlation') {
        parsed.value.forEach((q, qi) => {
          if (!isJsonObject(q) || typeof q.ruleId !== 'string' || !q.ruleId.trim()) {
            errors.push({
              field: `${prefix}.queries[${qi}]`,
              message: 'A signal_correlation query needs a "ruleId" referencing the correlated rule.',
              code: 'MISSING_RULE_ID',
            })
          }
        })
      }
    }
  }

  // --- cases -------------------------------------------------------------------
  if (!spec.casesRaw) {
    errors.push({ field: `${prefix}.cases`, message: 'Cases is required — at least one case object.', code: 'EMPTY_CASES' })
  } else {
    const parsed = parseJsonArray(spec.casesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.cases`, message: 'Cases must be a valid JSON array.', code: 'INVALID_CASES_JSON' })
    } else if (parsed.value) {
      if (parsed.value.length === 0) {
        errors.push({ field: `${prefix}.cases`, message: 'At least one case is required.', code: 'EMPTY_CASES' })
      } else if (isCloudConfig && parsed.value.length !== 1) {
        errors.push({
          field: `${prefix}.cases`,
          message: 'cloud_configuration rules must declare exactly one case (its status is the finding severity).',
          code: 'CLOUD_CONFIG_CASE_COUNT',
        })
      }
      parsed.value.forEach((c, ci) => {
        if (!isJsonObject(c)) {
          errors.push({ field: `${prefix}.cases[${ci}]`, message: 'Each case must be a JSON object.', code: 'INVALID_CASE' })
          return
        }
        if (!CASE_STATUSES.includes(c.status as (typeof CASE_STATUSES)[number])) {
          errors.push({
            field: `${prefix}.cases[${ci}].status`,
            message: `Case status must be one of ${CASE_STATUSES.join(', ')} (got "${String(c.status)}").`,
            code: 'INVALID_CASE_STATUS',
          })
        }
      })
    }
  }

  // --- options -------------------------------------------------------------------
  if (!spec.optionsRaw) {
    errors.push({ field: `${prefix}.options`, message: 'Options is required — at least an empty JSON object ({}).', code: 'EMPTY_OPTIONS' })
  } else {
    const parsed = parseJsonObject(spec.optionsRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.options`, message: 'Options must be a valid JSON object.', code: 'INVALID_OPTIONS_JSON' })
    } else if (parsed.value) {
      const opts = parsed.value
      for (const key of ['evaluationWindow', 'keepAlive', 'maxSignalDuration'] as const) {
        if (key in opts && !WINDOW_SECONDS.includes(opts[key] as (typeof WINDOW_SECONDS)[number])) {
          errors.push({
            field: `${prefix}.options.${key}`,
            message: `options.${key} must be one of ${WINDOW_SECONDS.join(', ')} seconds (got "${String(opts[key])}").`,
            code: 'INVALID_WINDOW_VALUE',
          })
        }
      }
      if ('detectionMethod' in opts && !DETECTION_METHODS.includes(opts.detectionMethod as (typeof DETECTION_METHODS)[number])) {
        errors.push({
          field: `${prefix}.options.detectionMethod`,
          message: `options.detectionMethod must be one of ${DETECTION_METHODS.join(', ')} (got "${String(opts.detectionMethod)}").`,
          code: 'INVALID_DETECTION_METHOD',
        })
      }
      if (isCloudConfig && !isJsonObject(opts.complianceRuleOptions)) {
        warnings.push({
          field: `${prefix}.options.complianceRuleOptions`,
          message: 'cloud_configuration rules typically need options.complianceRuleOptions (resourceType + a Rego policy) — see the Detection group help text.',
          code: 'CLOUD_CONFIG_MISSING_COMPLIANCE_OPTIONS',
        })
      }
    }
  }

  validateFilters(spec, prefix, errors)
}

/** Every query object needs a non-empty "query" string; aggregation/dataSource, when set, must be supported. */
function validateStandardQuery(q: unknown, field: string, errors: ValidationError[]): void {
  if (!isJsonObject(q)) {
    errors.push({ field, message: 'Each query must be a JSON object.', code: 'INVALID_QUERY' })
    return
  }
  if (typeof q.query !== 'string' || !q.query.trim()) {
    errors.push({ field: `${field}.query`, message: 'A "query" string is required.', code: 'EMPTY_QUERY_STRING' })
  }
  if ('aggregation' in q && !QUERY_AGGREGATIONS.includes(q.aggregation as (typeof QUERY_AGGREGATIONS)[number])) {
    errors.push({
      field: `${field}.aggregation`,
      message: `aggregation must be one of ${QUERY_AGGREGATIONS.join(', ')} (got "${String(q.aggregation)}").`,
      code: 'INVALID_AGGREGATION',
    })
  }
  if ('dataSource' in q && !QUERY_DATA_SOURCES.includes(q.dataSource as (typeof QUERY_DATA_SOURCES)[number])) {
    errors.push({
      field: `${field}.dataSource`,
      message: `dataSource must be one of ${QUERY_DATA_SOURCES.join(', ')} (got "${String(q.dataSource)}").`,
      code: 'INVALID_DATA_SOURCE',
    })
  }
}

function validateFilters(spec: RuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.filtersRaw) return // optional
  const parsed = parseJsonArray(spec.filtersRaw)
  if (!parsed.ok) {
    errors.push({ field: `${prefix}.filters`, message: 'Filters must be a valid JSON array.', code: 'INVALID_FILTERS_JSON' })
    return
  }
  parsed.value?.forEach((f, fi) => {
    if (!isJsonObject(f)) {
      errors.push({ field: `${prefix}.filters[${fi}]`, message: 'Each filter must be a JSON object.', code: 'INVALID_FILTER' })
      return
    }
    if ('action' in f && !FILTER_ACTIONS.includes(f.action as (typeof FILTER_ACTIONS)[number])) {
      errors.push({
        field: `${prefix}.filters[${fi}].action`,
        message: `filter action must be one of ${FILTER_ACTIONS.join(', ')} (got "${String(f.action)}").`,
        code: 'INVALID_FILTER_ACTION',
      })
    }
  })
}

/** Fallback shape-only checks used when `type` itself is invalid (so a bad type doesn't also mask a JSON error). */
function validateQueriesShapeOnly(spec: RuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.queriesRaw) {
    errors.push({ field: `${prefix}.queries`, message: 'Queries is required — at least a JSON array ([]).', code: 'EMPTY_QUERIES' })
  } else if (!parseJsonArray(spec.queriesRaw).ok) {
    errors.push({ field: `${prefix}.queries`, message: 'Queries must be a valid JSON array.', code: 'INVALID_QUERIES_JSON' })
  }
}

function validateCasesShapeOnly(spec: RuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.casesRaw) {
    errors.push({ field: `${prefix}.cases`, message: 'Cases is required — at least one case object.', code: 'EMPTY_CASES' })
  } else if (!parseJsonArray(spec.casesRaw).ok) {
    errors.push({ field: `${prefix}.cases`, message: 'Cases must be a valid JSON array.', code: 'INVALID_CASES_JSON' })
  }
}

function validateOptionsShapeOnly(spec: RuleSpec, prefix: string, errors: ValidationError[]): void {
  if (!spec.optionsRaw) {
    errors.push({ field: `${prefix}.options`, message: 'Options is required — at least an empty JSON object ({}).', code: 'EMPTY_OPTIONS' })
  } else if (!parseJsonObject(spec.optionsRaw).ok) {
    errors.push({ field: `${prefix}.options`, message: 'Options must be a valid JSON object.', code: 'INVALID_OPTIONS_JSON' })
  }
}
