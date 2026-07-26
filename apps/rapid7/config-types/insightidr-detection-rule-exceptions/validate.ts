import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { PRIORITY_LEVELS, RULE_ACTIONS } from '../../lib/insightidr-rules'

/** Exception logic form: key-value conditions (SIMPLE) or a raw LEQL query. */
export const EXCEPTION_TYPES = ['SIMPLE', 'LEQL'] as const

/** Condition operators accepted by a SIMPLE key-value exception. */
export const OPERATORS = ['IS', 'CONTAINS', 'STARTSWITH', 'ENDSWITH', 'CIDR', 'REGEX'] as const

/** Service levels an exception can target. */
export const SERVICE_LEVELS = ['MDR', 'Customer', 'ALL'] as const

/** Maximum key-value conditions a single SIMPLE exception may declare (API cap). */
export const MAX_CONDITIONS = 10

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ExceptionSpec {
  sectionName: string
  ruleName: string
  name: string
  type: string
  ruleAction: string
  priorityLevel: string
  serviceLevel: string
  keyValueJson: string
  leql: string
  note: string
}

/** A single SIMPLE key-value condition. */
export interface ExceptionCondition {
  key: string
  value: string
  operator: string
  case_sensitive?: boolean
}

/** Shape of a rule exception returned by GET /rules/{rrn}/rule-exceptions. */
export interface LiveRuleException {
  rrn?: string
  name?: string
  rule_action?: string
  priorityLevel?: string
}

/** The (rule name, exception name) natural key — an exception's logical identity. */
export function exceptionKey(spec: { ruleName: string; name: string }): string {
  return JSON.stringify([spec.ruleName.trim().toLowerCase(), spec.name.trim().toLowerCase()])
}

/** A human-readable label for an exception, e.g. `svc-backup on Suspicious Auth`. */
export function exceptionLabel(spec: ExceptionSpec): string {
  return `${spec.name} on "${spec.ruleName}"`
}

/**
 * Parse the SIMPLE key-value conditions JSON. NON-UNION { value, error } (never a
 * discriminated union — the platform loader can't narrow those).
 */
export interface ConditionsParseResult {
  value: ExceptionCondition[] | null
  error: string | null
}

export function parseConditions(raw: string | undefined): ConditionsParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON array of { key, value, operator } conditions' }
  }
  if (parsed.length < 1 || parsed.length > MAX_CONDITIONS) {
    return { value: null, error: `must contain between 1 and ${MAX_CONDITIONS} conditions` }
  }
  const conditions: ExceptionCondition[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { value: null, error: `condition ${i + 1} must be an object` }
    }
    const rec = item as Record<string, unknown>
    const key = typeof rec.key === 'string' ? rec.key.trim() : ''
    const value = typeof rec.value === 'string' ? rec.value : ''
    const operator = typeof rec.operator === 'string' ? rec.operator.trim().toUpperCase() : 'IS'
    if (!key) return { value: null, error: `condition ${i + 1} is missing "key"` }
    if (!(OPERATORS as readonly string[]).includes(operator)) {
      return { value: null, error: `condition ${i + 1} operator "${operator}" is not one of ${OPERATORS.join(', ')}` }
    }
    if (rec.case_sensitive !== undefined && typeof rec.case_sensitive !== 'boolean') {
      return { value: null, error: `condition ${i + 1} "case_sensitive" must be true or false` }
    }
    const condition: ExceptionCondition = { key, value, operator }
    if (typeof rec.case_sensitive === 'boolean') condition.case_sensitive = rec.case_sensitive
    conditions.push(condition)
  }
  return { value: conditions, error: null }
}

/** Each canvas item describes one InsightIDR detection rule exception. */
export function extractExceptionSpecs(canvas: CanvasSnapshot): ExceptionSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return {
      sectionName: section.name,
      ruleName: str(fields.rule_name),
      name: str(fields.name),
      type: str(fields.type) || 'SIMPLE',
      ruleAction: str(fields.rule_action),
      priorityLevel: str(fields.priority_level),
      serviceLevel: str(fields.service_level),
      keyValueJson: typeof fields.key_value_json === 'string' ? fields.key_value_json : '',
      leql: typeof fields.leql === 'string' ? fields.leql : '',
      note: typeof fields.note === 'string' ? fields.note.trim() : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate detection rule exception configurations: a parent rule name, an
 * exception name, a type and a rule action are required; the type-specific logic
 * (key-value conditions for SIMPLE, a LEQL query for LEQL) is present and
 * well-formed; enums are from the supported sets; and the (rule, exception name)
 * natural key is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractExceptionSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Detection rule name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Exception name is required', code: 'required' })
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Exception type is required', code: 'required' })
    } else if (!(EXCEPTION_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported exception type "${spec.type}"`, code: 'invalid_type' })
    }

    if (!spec.ruleAction) {
      errors.push({ field: `${prefix}.rule_action`, message: 'Rule action is required', code: 'required' })
    } else if (!(RULE_ACTIONS as readonly string[]).includes(spec.ruleAction)) {
      errors.push({ field: `${prefix}.rule_action`, message: `Unsupported rule action "${spec.ruleAction}"`, code: 'invalid_rule_action' })
    }

    if (spec.priorityLevel && !(PRIORITY_LEVELS as readonly string[]).includes(spec.priorityLevel)) {
      errors.push({ field: `${prefix}.priority_level`, message: `Unsupported priority "${spec.priorityLevel}"`, code: 'invalid_priority' })
    }
    if (spec.serviceLevel && !(SERVICE_LEVELS as readonly string[]).includes(spec.serviceLevel)) {
      errors.push({ field: `${prefix}.service_level`, message: `Unsupported service level "${spec.serviceLevel}"`, code: 'invalid_service_level' })
    }

    if (spec.type === 'LEQL') {
      if (!spec.leql.trim()) {
        errors.push({ field: `${prefix}.leql`, message: 'A LEQL exception requires a LEQL query', code: 'required' })
      }
    } else if (spec.type === 'SIMPLE') {
      const parsed = parseConditions(spec.keyValueJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.key_value_json`, message: `Key-value conditions ${parsed.error}`, code: 'invalid_conditions' })
      } else if (!parsed.value || parsed.value.length === 0) {
        errors.push({ field: `${prefix}.key_value_json`, message: 'A SIMPLE exception requires at least one key-value condition', code: 'required' })
      }
    }

    if (spec.ruleName && spec.name) {
      const key = exceptionKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate exception "${spec.name}" on "${spec.ruleName}" — each (rule, exception name) may only be declared once`,
          code: 'duplicate_exception',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
