import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractBusinessServiceSpecs } from './_shared'

/**
 * Validate business service items. Static — no target access required:
 *   - name is required and unique across the canvas (its reconciliation identity)
 * description, point_of_contact and team are free text and need no validation
 * beyond the canvas maxLength; team (when supplied) is resolved to an id at
 * deploy time and fails the item there if no such team exists in the account.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractBusinessServiceSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one business service.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Business service name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(spec.name.toLowerCase())) {
      warnings.push({
        field: `${prefix}.name`,
        message: `Business service name "${spec.name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_NAME',
      })
    } else {
      seen.add(spec.name.toLowerCase())
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
