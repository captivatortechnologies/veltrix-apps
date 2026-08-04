import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractPolicyGroupSpecs } from './_shared'

/**
 * Validate Policy Group items: a non-empty, unique name (the logical identity).
 * Static — no target access required; unresolved member Policy names surface at
 * deploy time (they need the org's Policy list to resolve).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractPolicyGroupSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Policy Group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy Group name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 255) {
      errors.push({ field: `${prefix}.name`, message: 'Policy Group name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.name.toLowerCase())) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate Policy Group "${spec.name}" — each name may only be declared once per canvas.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }

    if (spec.memberPolicies.length === 0) {
      warnings.push({
        field: `${prefix}.memberPolicies`,
        message: `"${spec.name || 'group'}" declares no member Policies — deploying will empty the group's membership.`,
        code: 'NO_MEMBERS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
