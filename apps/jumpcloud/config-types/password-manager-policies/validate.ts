import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractPasswordManagerPolicySpecs } from './_shared'

/**
 * Validate the Password Manager Policy singleton: exactly one item must be
 * declared (repeatable: false in the canvas already enforces this in the UI —
 * this is the server-side backstop). Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractPasswordManagerPolicySpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'A Password Manager Policy configuration is required.', code: 'EMPTY' })
  } else if (specs.length > 1) {
    errors.push({ field: 'items', message: 'Password Manager Policy is a tenant singleton — declare exactly one item.', code: 'SINGLETON' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
