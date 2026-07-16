import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isIso8601Duration, slugify } from '../../lib/sentinel'

export const SEVERITIES = ['High', 'Medium', 'Low', 'Informational'] as const
export const TRIGGER_OPERATORS = ['GreaterThan', 'LessThan', 'Equal', 'NotEqual'] as const

export type Severity = (typeof SEVERITIES)[number]
export type TriggerOperator = (typeof TRIGGER_OPERATORS)[number]

/** One scheduled analytics rule authored on the canvas. */
export interface ScheduledRuleSpec {
  sectionName: string
  ruleName: string
  /** URL-safe ARM ruleId derived from the name (deterministic → idempotent PUT). */
  ruleId: string
  enabled: boolean
  severity: string
  query: string
  queryFrequency: string
  queryPeriod: string
  triggerOperator: string
  triggerThreshold: number
  tactics: string[]
  suppressionDuration: string
  suppressionEnabled: boolean
}

/** The reconciliation key is the slug of the rule name (also the ARM ruleId). */
export function ruleKey(name: string): string {
  return slugify(name)
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a number field. NON-UNION result: value is null when unparseable. */
export function readNumber(value: unknown): { value: number | null; error: string | null } {
  if (typeof value === 'number' && Number.isFinite(value)) return { value, error: null }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return { value: n, error: null }
    return { value: null, error: `"${value}" is not a number` }
  }
  return { value: null, error: null }
}

/** Each canvas item is one scheduled analytics rule. */
export function extractRuleSpecs(canvas: CanvasSnapshot): ScheduledRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.rule_name === 'string' ? fields.rule_name.trim() : ''
    const threshold = readNumber(fields.trigger_threshold)
    return {
      sectionName: section.name,
      ruleName: name,
      ruleId: slugify(name),
      enabled: readBool(fields.enabled, true),
      severity: typeof fields.severity === 'string' ? fields.severity.trim() : '',
      query: typeof fields.query === 'string' ? fields.query.trim() : '',
      queryFrequency: typeof fields.query_frequency === 'string' ? fields.query_frequency.trim() : '',
      queryPeriod: typeof fields.query_period === 'string' ? fields.query_period.trim() : '',
      triggerOperator: typeof fields.trigger_operator === 'string' ? fields.trigger_operator.trim() : '',
      triggerThreshold: threshold.value ?? 0,
      tactics: readList(fields.tactics),
      suppressionDuration: typeof fields.suppression_duration === 'string' ? fields.suppression_duration.trim() : '',
      suppressionEnabled: readBool(fields.suppression_enabled, false),
    }
  })
}

/**
 * Validate scheduled analytics rules. Each needs a unique name, a KQL query, an
 * ISO-8601 query frequency/period, a valid trigger operator + numeric threshold,
 * a severity, and an ISO-8601 suppression duration.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no analytics rules', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractRuleSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    } else {
      const key = ruleKey(spec.ruleName)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_name`,
          message: `Duplicate rule name "${spec.ruleName}" (names must be unique after slugging to "${key}")`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }

    if (!spec.query) {
      errors.push({ field: `${prefix}.query`, message: 'KQL query is required', code: 'required' })
    }

    if (!spec.queryFrequency) {
      errors.push({ field: `${prefix}.query_frequency`, message: 'Query frequency is required', code: 'required' })
    } else if (!isIso8601Duration(spec.queryFrequency)) {
      errors.push({
        field: `${prefix}.query_frequency`,
        message: `Query frequency "${spec.queryFrequency}" must be an ISO-8601 duration (e.g. PT1H, PT5M)`,
        code: 'invalid_duration',
      })
    }

    if (!spec.queryPeriod) {
      errors.push({ field: `${prefix}.query_period`, message: 'Query period is required', code: 'required' })
    } else if (!isIso8601Duration(spec.queryPeriod)) {
      errors.push({
        field: `${prefix}.query_period`,
        message: `Query period "${spec.queryPeriod}" must be an ISO-8601 duration (e.g. PT1H, P1D)`,
        code: 'invalid_duration',
      })
    }

    if (!SEVERITIES.includes(spec.severity as Severity)) {
      errors.push({
        field: `${prefix}.severity`,
        message: `Severity must be one of ${SEVERITIES.join(', ')}`,
        code: 'invalid_severity',
      })
    }

    if (!TRIGGER_OPERATORS.includes(spec.triggerOperator as TriggerOperator)) {
      errors.push({
        field: `${prefix}.trigger_operator`,
        message: `Trigger operator must be one of ${TRIGGER_OPERATORS.join(', ')}`,
        code: 'invalid_operator',
      })
    }

    if (!Number.isInteger(spec.triggerThreshold) || spec.triggerThreshold < 0) {
      errors.push({
        field: `${prefix}.trigger_threshold`,
        message: 'Trigger threshold must be a non-negative integer',
        code: 'invalid_threshold',
      })
    }

    if (!spec.suppressionDuration) {
      errors.push({ field: `${prefix}.suppression_duration`, message: 'Suppression duration is required', code: 'required' })
    } else if (!isIso8601Duration(spec.suppressionDuration)) {
      errors.push({
        field: `${prefix}.suppression_duration`,
        message: `Suppression duration "${spec.suppressionDuration}" must be an ISO-8601 duration (e.g. PT1H)`,
        code: 'invalid_duration',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
