import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { text, declaresChange, positiveIntOrUndefined } from './_shared'

/**
 * Validate Explorer Settings items: a non-empty Explorer reference is required (it doubles as the
 * identity). An item that declares neither a Site nor a Max Concurrent Scans value is a no-op and
 * is flagged so the operator notices before deploying nothing. maxConcurrentScans, if set, must be
 * a positive integer. Static — no target access required. A duplicate Explorer reference is
 * flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one explorer settings item.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const explorer = text(item.fields.explorer)

    if (!explorer) {
      errors.push({ field: `items[${i}].explorer`, message: 'Explorer is required.', code: 'EMPTY_EXPLORER' })
    } else if (seen.has(explorer.toLowerCase())) {
      warnings.push({
        field: `items[${i}].explorer`,
        message: `Explorer "${explorer}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_EXPLORER',
      })
    } else {
      seen.add(explorer.toLowerCase())
    }

    if (!declaresChange(item.fields)) {
      warnings.push({
        field: `items[${i}]`,
        message: `"${explorer || 'This item'}" declares neither a Site nor Max Concurrent Scans — deploy will have nothing to apply.`,
        code: 'NO_OP_ITEM',
      })
    }

    const maxConcurrentRaw = item.fields.maxConcurrentScans
    if (maxConcurrentRaw !== '' && maxConcurrentRaw !== null && maxConcurrentRaw !== undefined && positiveIntOrUndefined(maxConcurrentRaw) === undefined) {
      warnings.push({
        field: `items[${i}].maxConcurrentScans`,
        message: 'Max Concurrent Scans should be a positive whole number.',
        code: 'SUSPECT_MAX_CONCURRENT_SCANS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
