import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractConditionalAccessPolicySpecs, parseJsonObjectField, AUTHN_POLICY_TYPES, AUTHN_POLICY_ACTIONS } from './_shared'

/**
 * Validate Authentication Policy items: a non-empty, unique name (the logical
 * identity), a recognized `type` and `action`, and well-formed `targets` /
 * `conditions` JSON objects. Static — no target access required.
 *
 * A policy with no `targets` declared is accepted but warned about — JumpCloud
 * treats an empty targets object as "applies to nothing meaningful" for most
 * target kinds, so an operator almost always wants to scope it.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractConditionalAccessPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Authentication Policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate policy "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Applies To (type) is required.', code: 'EMPTY_TYPE' })
    } else if (!(AUTHN_POLICY_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `type must be one of: ${AUTHN_POLICY_TYPES.join(', ')}.`, code: 'INVALID_TYPE' })
    }

    if (!(AUTHN_POLICY_ACTIONS as readonly string[]).includes(spec.action)) {
      errors.push({ field: `${prefix}.action`, message: `action must be one of: ${AUTHN_POLICY_ACTIONS.join(', ')}.`, code: 'INVALID_ACTION' })
    }

    const targets = parseJsonObjectField(spec.targetsRaw, 'targets')
    if (targets.error) {
      errors.push({ field: `${prefix}.targetsRaw`, message: targets.error, code: 'INVALID_TARGETS' })
    } else if (Object.keys(targets.value).length === 0) {
      warnings.push({
        field: `${prefix}.targetsRaw`,
        message: `"${spec.name || 'policy'}" declares no targets — scope it (users / userGroups / resources) so it applies where intended.`,
        code: 'NO_TARGETS',
      })
    }

    const conditions = parseJsonObjectField(spec.conditionsRaw, 'conditions')
    if (conditions.error) {
      errors.push({ field: `${prefix}.conditionsRaw`, message: conditions.error, code: 'INVALID_CONDITIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
