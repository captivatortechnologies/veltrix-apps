import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { slugify } from '../../lib/sentinel'

export const TRIGGERS_ON = ['Incidents', 'Alerts'] as const
export const TRIGGERS_WHEN = ['Created', 'Updated'] as const
export const INCIDENT_SEVERITIES = ['High', 'Medium', 'Low', 'Informational'] as const
export const INCIDENT_STATUSES = ['New', 'Active', 'Closed'] as const

/** One automation rule authored on the canvas. */
export interface AutomationRuleSpec {
  sectionName: string
  ruleName: string
  /** URL-safe ARM automationRuleId derived from the name (deterministic → idempotent PUT). */
  ruleId: string
  enabled: boolean
  order: number
  triggersOn: string
  triggersWhen: string
  /** Empty string means "no change" — omitted from the ModifyProperties action. */
  setSeverity: string
  setStatus: string
}

/** The reconciliation key is the slug of the rule name (also the ARM automationRuleId). */
export function ruleKey(name: string): string {
  return slugify(name)
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
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

/** Each canvas item is one automation rule. */
export function extractAutomationSpecs(canvas: CanvasSnapshot): AutomationRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.rule_name === 'string' ? fields.rule_name.trim() : ''
    const order = readNumber(fields.order)
    return {
      sectionName: section.name,
      ruleName: name,
      ruleId: slugify(name),
      enabled: readBool(fields.enabled, true),
      order: order.value ?? 1,
      triggersOn: typeof fields.triggers_on === 'string' ? fields.triggers_on.trim() : '',
      triggersWhen: typeof fields.triggers_when === 'string' ? fields.triggers_when.trim() : '',
      setSeverity: typeof fields.set_severity === 'string' ? fields.set_severity.trim() : '',
      setStatus: typeof fields.set_status === 'string' ? fields.set_status.trim() : '',
    }
  })
}

/**
 * Validate automation rules. Each needs a unique name, an execution order (1–1000),
 * a valid trigger (on Incidents/Alerts, when Created/Updated), and at least one
 * modify-properties action (set severity and/or status) so the rule does something.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no automation rules', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const section of sections) {
    const fields = section.fields ?? {}
    const prefix = section.name
    const name = typeof fields.rule_name === 'string' ? fields.rule_name.trim() : ''

    if (!name) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Rule name is required', code: 'required' })
    } else {
      const key = ruleKey(name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_name`,
          message: `Duplicate rule name "${name}" (names must be unique after slugging to "${key}")`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }

    const order = readNumber(fields.order)
    if (order.error) {
      errors.push({ field: `${prefix}.order`, message: order.error, code: 'invalid_order' })
    } else if (order.value == null || !Number.isInteger(order.value) || order.value < 1 || order.value > 1000) {
      errors.push({ field: `${prefix}.order`, message: 'Order must be an integer between 1 and 1000', code: 'invalid_order' })
    }

    const triggersOn = typeof fields.triggers_on === 'string' ? fields.triggers_on.trim() : ''
    if (!TRIGGERS_ON.includes(triggersOn as (typeof TRIGGERS_ON)[number])) {
      errors.push({ field: `${prefix}.triggers_on`, message: `Triggers on must be one of ${TRIGGERS_ON.join(', ')}`, code: 'invalid_trigger' })
    }

    const triggersWhen = typeof fields.triggers_when === 'string' ? fields.triggers_when.trim() : ''
    if (!TRIGGERS_WHEN.includes(triggersWhen as (typeof TRIGGERS_WHEN)[number])) {
      errors.push({ field: `${prefix}.triggers_when`, message: `Triggers when must be one of ${TRIGGERS_WHEN.join(', ')}`, code: 'invalid_trigger' })
    }

    const setSeverity = typeof fields.set_severity === 'string' ? fields.set_severity.trim() : ''
    const setStatus = typeof fields.set_status === 'string' ? fields.set_status.trim() : ''

    if (setSeverity && !INCIDENT_SEVERITIES.includes(setSeverity as (typeof INCIDENT_SEVERITIES)[number])) {
      errors.push({ field: `${prefix}.set_severity`, message: `Set severity must be one of ${INCIDENT_SEVERITIES.join(', ')}`, code: 'invalid_severity' })
    }
    if (setStatus && !INCIDENT_STATUSES.includes(setStatus as (typeof INCIDENT_STATUSES)[number])) {
      errors.push({ field: `${prefix}.set_status`, message: `Set status must be one of ${INCIDENT_STATUSES.join(', ')}`, code: 'invalid_status' })
    }
    if (!setSeverity && !setStatus) {
      errors.push({
        field: `${prefix}.set_severity`,
        message: 'Configure at least one action — set a severity and/or a status for the modify-properties action',
        code: 'no_action',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
