import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NETWORKS } from './_shared'

/**
 * Validate EdgeWorker Activation items: a non-empty EdgeWorker name, a
 * non-empty version and a known network (STAGING/PRODUCTION). Static — no
 * target access required (whether the EdgeWorker/version actually exists is
 * checked at deploy time). The (edgeWorkerName, network) pair is the
 * identity, so a duplicate pair is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one activation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const edgeWorkerName = String(item.fields.edgeWorkerName ?? '').trim()
    const version = String(item.fields.version ?? '').trim()
    const rawNetwork = String(item.fields.network ?? '').trim().toUpperCase()

    if (!edgeWorkerName) {
      errors.push({ field: `items[${i}].edgeWorkerName`, message: 'EdgeWorker name is required.', code: 'EMPTY_NAME' })
    }

    if (!version) {
      errors.push({ field: `items[${i}].version`, message: 'Version is required.', code: 'EMPTY_VERSION' })
    }

    if (!NETWORKS.has(rawNetwork)) {
      errors.push({ field: `items[${i}].network`, message: `Environment must be STAGING or PRODUCTION (got "${rawNetwork || '(empty)'}").`, code: 'INVALID_NETWORK' })
    }

    if (edgeWorkerName && NETWORKS.has(rawNetwork)) {
      const key = `${edgeWorkerName.toLowerCase()} ${rawNetwork}`
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].edgeWorkerName`, message: `"${edgeWorkerName}" → ${rawNetwork} is listed more than once; the last one wins.`, code: 'DUPLICATE_TARGET' })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
