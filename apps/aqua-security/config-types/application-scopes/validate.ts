import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractApplicationScopeSpecs } from './_shared'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Validate application-scope items: a non-empty unique name, a well-formed
 * owner email when given, and at least one scoping dimension populated (an
 * entirely empty scope matches nothing useful). Static — no target access
 * required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractApplicationScopeSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one application scope.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Scope name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > 128) {
      errors.push({ field: `items[${i}].name`, message: 'Scope name must be 128 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Scope name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    if (spec.ownerEmail && !EMAIL_RE.test(spec.ownerEmail)) {
      errors.push({ field: `items[${i}].ownerEmail`, message: `Owner email "${spec.ownerEmail}" does not look like a valid email address.`, code: 'INVALID_EMAIL' })
    }

    const hasAnyDimension = Boolean(
      spec.imageExpression || spec.kubernetesWorkloadExpression || spec.kubernetesInfraExpression,
    )
    if (!hasAnyDimension && spec.name.toLowerCase() !== 'global') {
      warnings.push({
        field: `items[${i}]`,
        message: 'This scope has no image, Kubernetes workload, or Kubernetes infrastructure expression — it will match nothing.',
        code: 'EMPTY_SCOPE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
