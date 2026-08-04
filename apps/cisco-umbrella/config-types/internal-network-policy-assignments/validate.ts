import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { POLICY_TYPES, assignmentKey, extractPolicyAssignmentSpecs, isPolicyType } from './_shared'

/**
 * Validate policy-assignment items: a non-empty identity name, a known policy
 * type (dns/web), a non-empty policy name, and no exact duplicate (same
 * identity + policy type + policy name declared twice). Static — whether the
 * named subnet/policy actually exists is only checked at deploy/drift time (it
 * requires a live Umbrella lookup).
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractPolicyAssignmentSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one policy assignment.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.identityName) {
      errors.push({ field: `${prefix}.identityName`, message: 'Internal network subnet name is required.', code: 'required' })
    }

    if (!isPolicyType(spec.policyType)) {
      errors.push({
        field: `${prefix}.policyType`,
        message: `Policy type must be one of ${POLICY_TYPES.join(', ')} (got "${spec.policyType}").`,
        code: 'invalid_policy_type',
      })
    }

    if (!spec.policyName) {
      errors.push({ field: `${prefix}.policyName`, message: 'Policy name is required.', code: 'required' })
    }

    if (spec.identityName && spec.policyName) {
      const key = assignmentKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: prefix,
          message: `Duplicate assignment of "${spec.identityName}" to ${spec.policyType} policy "${spec.policyName}" — each may only be declared once per canvas.`,
          code: 'duplicate_assignment',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
