import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { PRIORITY_LEVELS, RULE_ACTIONS } from '../../lib/insightidr-rules'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RuleSettingSpec {
  sectionName: string
  ruleName: string
  ruleAction: string
  priorityLevel: string
}

/** The rule name natural key — the portable identity of a managed detection rule. */
export function ruleKey(spec: { ruleName: string }): string {
  return spec.ruleName.trim().toLowerCase()
}

/** Each canvas item describes the desired settings for one detection rule. */
export function extractRuleSettingSpecs(canvas: CanvasSnapshot): RuleSettingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return {
      sectionName: section.name,
      ruleName: str(fields.rule_name),
      ruleAction: str(fields.rule_action),
      priorityLevel: str(fields.priority_level),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate detection rule settings: a rule name and a rule action are required,
 * the action and (optional) priority are from the supported sets, and each rule
 * name is declared at most once across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleSettingSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ruleName) {
      errors.push({ field: `${prefix}.rule_name`, message: 'Detection rule name is required', code: 'required' })
    }

    if (!spec.ruleAction) {
      errors.push({ field: `${prefix}.rule_action`, message: 'Rule action is required', code: 'required' })
    } else if (!(RULE_ACTIONS as readonly string[]).includes(spec.ruleAction)) {
      errors.push({ field: `${prefix}.rule_action`, message: `Unsupported rule action "${spec.ruleAction}"`, code: 'invalid_rule_action' })
    }

    if (spec.priorityLevel && !(PRIORITY_LEVELS as readonly string[]).includes(spec.priorityLevel)) {
      errors.push({ field: `${prefix}.priority_level`, message: `Unsupported priority "${spec.priorityLevel}"`, code: 'invalid_priority' })
    }

    if (spec.ruleName) {
      const key = ruleKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.rule_name`,
          message: `Duplicate rule "${spec.ruleName}" — each detection rule may only be configured once`,
          code: 'duplicate_rule',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
