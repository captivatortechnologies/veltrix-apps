import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { blockedItemKey, extractBlockedItemSpecs } from './_shared'

const SHA256_RE = /^[A-Fa-f0-9]{64}$/

/**
 * Validate blocked item(s): a well-formed unique SHA256 and a required
 * comment. Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one blocked item.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractBlockedItemSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.sha256) {
      errors.push({ field: `${prefix}.sha256`, message: 'SHA256 is required.', code: 'REQUIRED' })
    } else if (!SHA256_RE.test(spec.sha256)) {
      errors.push({ field: `${prefix}.sha256`, message: `"${spec.sha256}" is not a 64-character hexadecimal SHA256 checksum.`, code: 'INVALID_SHA256' })
    } else {
      const key = blockedItemKey(spec.sha256)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.sha256`, message: `SHA256 "${spec.sha256}" is listed more than once; the last one wins.`, code: 'DUPLICATE_SHA256' })
      } else {
        seen.add(key)
      }
    }

    if (!spec.comment) {
      errors.push({ field: `${prefix}.comment`, message: 'A comment explaining why this item is blocked is required.', code: 'REQUIRED' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
