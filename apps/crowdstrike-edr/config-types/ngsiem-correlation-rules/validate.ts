import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Correlation Rules API constraints ---------------------------------------
//
// A Next-Gen SIEM correlation rule runs a scheduled CQL (CrowdStrike Query
// Language) search and raises a detection when it matches. Its identity in the
// tenant is `name`. Verified against the Terraform resource
// crowdstrike_correlation_rule and the FalconPy correlation_rules service class.
// The API stores severity as an int32 on a fixed 10/30/50/70/90 scale; the named
// levels are mapped at deploy time. `create_case` is expressed as the wire field
// search.outcome ("detection" vs "case"), and the schedule cadence is the wire
// field operation.schedule.definition ("@every <frequency>").

export const CORRELATION_SEVERITIES = ['informational', 'low', 'medium', 'high', 'critical'] as const
export type CorrelationSeverity = (typeof CORRELATION_SEVERITIES)[number]

/** Named severity → the int32 the Correlation Rules API stores it as. */
export const SEVERITY_TO_NUMBER: Record<CorrelationSeverity, number> = {
  informational: 10,
  low: 30,
  medium: 50,
  high: 70,
  critical: 90,
}

/** int32 severity → named level, for drift messages. */
export const SEVERITY_NUMBER_TO_NAME: Record<number, CorrelationSeverity> = {
  10: 'informational',
  30: 'low',
  50: 'medium',
  70: 'high',
  90: 'critical',
}

export const RULE_STATUSES = ['active', 'inactive'] as const
export type RuleStatus = (typeof RULE_STATUSES)[number]

export const TRIGGER_MODES = ['summary', 'verbose'] as const
export type TriggerMode = (typeof TRIGGER_MODES)[number]

/** Schedule cadences offered on the canvas — each is a valid Go duration. */
export const SCHEDULE_FREQUENCIES = ['5m', '15m', '30m', '1h', '6h', '12h', '24h'] as const

export const MAX_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface CorrelationRuleSpec {
  sectionName: string
  name: string
  description: string
  search: string
  severity: string
  frequency: string
  triggerMode: string
  mitreTactic: string
  mitreTechnique: string
  status: string
  createCase: boolean
  publish: boolean
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const lower = (value: unknown): string => str(value).toLowerCase()

/** Each canvas section describes one correlation rule. */
export function extractCorrelationRuleSpecs(canvas: CanvasSnapshot): CorrelationRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      search: str(fields.search),
      severity: lower(fields.severity) || 'medium',
      frequency: lower(fields.frequency),
      triggerMode: lower(fields.triggerMode) || 'summary',
      mitreTactic: str(fields.mitreTactic),
      mitreTechnique: str(fields.mitreTechnique),
      // Inactive by default so a deploy never silently activates a noisy detection.
      status: lower(fields.status) || 'inactive',
      createCase: coerceBoolean(fields.createCase, false),
      publish: coerceBoolean(fields.publish, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate correlation-rule configurations against the Correlation Rules API:
 * a unique name (≤255), a non-empty CQL search, a recognized severity, status,
 * trigger mode, and schedule frequency, and well-formed MITRE mapping.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCorrelationRuleSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // search (CQL) — the detection logic; a rule with no query matches nothing
    if (!spec.search) {
      errors.push({
        field: `${prefix}.search`,
        message: 'A CQL search query is required',
        code: 'required',
      })
    }

    // severity
    if (!(CORRELATION_SEVERITIES as readonly string[]).includes(spec.severity)) {
      errors.push({
        field: `${prefix}.severity`,
        message: `Severity must be one of: ${CORRELATION_SEVERITIES.join(', ')}`,
        code: 'invalid_severity',
      })
    }

    // status
    if (!(RULE_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${RULE_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // trigger mode
    if (!(TRIGGER_MODES as readonly string[]).includes(spec.triggerMode)) {
      errors.push({
        field: `${prefix}.triggerMode`,
        message: `Trigger mode must be one of: ${TRIGGER_MODES.join(', ')}`,
        code: 'invalid_trigger_mode',
      })
    }

    // frequency (schedule cadence) — a scheduled rule needs one
    if (!spec.frequency) {
      errors.push({ field: `${prefix}.frequency`, message: 'A run frequency is required', code: 'required' })
    } else if (!(SCHEDULE_FREQUENCIES as readonly string[]).includes(spec.frequency)) {
      errors.push({
        field: `${prefix}.frequency`,
        message: `Run frequency must be one of: ${SCHEDULE_FREQUENCIES.join(', ')}`,
        code: 'invalid_frequency',
      })
    }

    // MITRE mapping — a technique without its tactic is an incomplete mapping
    if (spec.mitreTechnique && !spec.mitreTactic) {
      warnings.push({
        field: `${prefix}.mitreTactic`,
        message: 'A MITRE technique is set without a tactic — add the tactic id (e.g. TA0004) to complete the mapping',
        code: 'mitre_tactic_missing',
      })
    }

    // publishing an inactive rule is valid, but the rule still will not run
    if (spec.publish && spec.status === 'inactive') {
      warnings.push({
        field: `${prefix}.publish`,
        message: 'Publishing an inactive rule saves the version but the rule will not run until its status is active',
        code: 'publish_inactive',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
