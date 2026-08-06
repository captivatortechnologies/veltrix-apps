import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractPolicyAssignmentSpecs } from './_shared'

/**
 * Validate policy assignment(s): a name, at least one target id, and a
 * consistent policyId/inheritFromAbove/forcePolicyInheritance combination —
 * mirroring assignPolicy's documented mutual-exclusivity rules. Static — no
 * target access (this app does not verify a policyId actually exists at
 * validate time; deploy surfaces GravityZone's own error if it doesn't).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one policy assignment.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicyAssignmentSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.assignmentName) {
      errors.push({ field: `${prefix}.assignmentName`, message: 'Assignment Name is required.', code: 'REQUIRED' })
    } else {
      const key = spec.assignmentName.trim().toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.assignmentName`, message: `Assignment "${spec.assignmentName}" is declared more than once.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (spec.targetIds.length === 0) {
      errors.push({ field: `${prefix}.targetIds`, message: 'At least one Target Endpoint ID is required.', code: 'REQUIRED' })
    }

    if (spec.inheritFromAbove) {
      if (spec.policyId) {
        errors.push({ field: `${prefix}.policyId`, message: 'Policy ID must be blank when Inherit From Above is checked.', code: 'MUTUALLY_EXCLUSIVE' })
      }
      if (spec.forcePolicyInheritance) {
        errors.push({
          field: `${prefix}.forcePolicyInheritance`,
          message: 'Force Policy Inheritance to Children requires a Policy ID and cannot be combined with Inherit From Above.',
          code: 'MUTUALLY_EXCLUSIVE',
        })
      }
    } else if (!spec.policyId) {
      errors.push({ field: `${prefix}.policyId`, message: 'Policy ID is required unless Inherit From Above is checked.', code: 'REQUIRED' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
