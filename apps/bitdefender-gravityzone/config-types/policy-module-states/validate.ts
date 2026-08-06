import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractPolicyModuleStateSpecs, parseSettings } from './_shared'

/**
 * Validate policy module state declaration(s): a required policyId, unique
 * per canvas, and parseable Settings JSON. Static — no target access (this
 * app does not verify a policyId actually exists at validate time; deploy
 * surfaces GravityZone's own error if it doesn't).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one policy module states declaration.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicyModuleStateSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.policyId) {
      errors.push({ field: `${prefix}.policyId`, message: 'Policy ID is required.', code: 'REQUIRED' })
    } else {
      const key = spec.policyId.trim().toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.policyId`, message: `Policy "${spec.policyId}" is declared more than once; the last one wins.`, code: 'DUPLICATE_POLICY' })
      } else {
        seen.add(key)
      }
    }

    if (!spec.settingsRaw) {
      errors.push({ field: `${prefix}.settings`, message: 'Settings is required.', code: 'REQUIRED' })
    } else {
      const { error } = parseSettings(spec)
      if (error) errors.push({ field: `${prefix}.settings`, message: error, code: 'INVALID_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
