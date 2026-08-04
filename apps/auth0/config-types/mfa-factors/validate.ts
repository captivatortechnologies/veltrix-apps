import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { POLICY_VALUES } from './_shared'

/**
 * Validate the Auth0 MFA (Guardian) singleton: at most one declared item and a
 * known policy value. The 8 factor fields are checkboxes with an explicit
 * default (false), so they need no further validation. Static: no target
 * access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add the MFA Factors item.', code: 'EMPTY' })
  }
  if (items.length > 1) {
    errors.push({ field: 'items', message: 'MFA Factors is a singleton — declare it only once per canvas', code: 'singleton' })
  }

  items.forEach((item, i) => {
    const policy = readString(item.fields.policy)
    if (!POLICY_VALUES.has(policy)) {
      errors.push({
        field: `items[${i}].policy`,
        message: `MFA policy must be one of ${[...POLICY_VALUES].join(', ')} (got "${policy}").`,
        code: 'INVALID_POLICY',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
