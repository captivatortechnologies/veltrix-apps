import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { TAXONOMY_STATES } from './_shared'

/**
 * Validate taxonomy items: a non-empty namespace and a known enable state.
 * Static — no target access required. The namespace doubles as the taxonomy
 * identity, so a duplicate namespace is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one taxonomy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const namespace = String(item.fields.namespace ?? '').trim()
    const state = String(item.fields.state ?? '').trim()

    if (!namespace) {
      errors.push({ field: `items[${i}].namespace`, message: 'Taxonomy namespace is required.', code: 'EMPTY_NAMESPACE' })
    } else if (seen.has(namespace.toLowerCase())) {
      warnings.push({ field: `items[${i}].namespace`, message: `Taxonomy namespace ${namespace} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAMESPACE' })
    } else {
      seen.add(namespace.toLowerCase())
    }

    if (!TAXONOMY_STATES.has(state)) {
      errors.push({ field: `items[${i}].state`, message: `State must be enabled or disabled (got "${state}").`, code: 'INVALID_STATE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
