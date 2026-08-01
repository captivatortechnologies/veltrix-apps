import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractPolicySpecs, parseEscalationRules } from './_shared'

/**
 * Validate escalation policy items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 *   - num_loops, when supplied, must be a non-negative integer
 *   - escalation_rules must parse to a non-empty JSON array where every rule has a
 *     positive escalation_delay_in_minutes and at least one valid target
 *     ({ type: user_reference|schedule_reference, id })
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractPolicySpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one escalation policy.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Escalation policy name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Escalation policy name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    const numLoops = spec.numLoops
    if (numLoops !== null && (Number.isNaN(numLoops) || !Number.isInteger(numLoops) || numLoops < 0)) {
      errors.push({
        field: `${prefix}.num_loops`,
        message: 'Loop count must be a non-negative integer.',
        code: 'INVALID_NUM_LOOPS',
      })
    }

    const parsed = parseEscalationRules(spec.rulesJson)
    if (parsed.error) {
      errors.push({ field: `${prefix}.escalation_rules`, message: `Escalation rules ${parsed.error}.`, code: 'INVALID_RULES' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
