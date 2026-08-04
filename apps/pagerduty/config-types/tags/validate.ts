import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractTagSpecs, parseAssignments } from './_shared'

/**
 * Validate tag items. Static — no target access required:
 *   - label is required and unique across the canvas (its reconciliation identity)
 *   - assignments, when supplied, must parse to a JSON array where every element
 *     has an entity_type of users|teams|escalation_policies and a non-empty
 *     entity_name (the user's email for "users", the name otherwise)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractTagSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tag.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'Tag label is required.', code: 'EMPTY_LABEL' })
    } else if (seen.has(spec.label.toLowerCase())) {
      warnings.push({
        field: `${prefix}.label`,
        message: `Tag label "${spec.label}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_LABEL',
      })
    } else {
      seen.add(spec.label.toLowerCase())
    }

    const parsed = parseAssignments(spec.assignmentsJson)
    if (parsed.error) {
      errors.push({ field: `${prefix}.assignments`, message: `Assignments ${parsed.error}.`, code: 'INVALID_ASSIGNMENTS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
