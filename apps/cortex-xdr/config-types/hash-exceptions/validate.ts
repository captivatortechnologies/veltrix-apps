import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { HASH_LIST_TYPES, isSha256 } from './_shared'

/**
 * Validate hash-exception items: a SHA256 hash value and a known list type
 * (allowlist / blocklist). Static — no target access required. The hash value is
 * the item identity, so a duplicate hash is flagged (last one wins). The comment
 * is optional. VERIFY that the tenant accepts SHA256 (only) against live Cortex XDR.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one hash exception.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const hash = String(item.fields.hash ?? '').trim()
    const listType = String(item.fields.list_type ?? '').trim().toLowerCase()

    if (!hash) {
      errors.push({ field: `items[${i}].hash`, message: 'Hash value is required.', code: 'EMPTY_HASH' })
    } else if (!isSha256(hash)) {
      errors.push({ field: `items[${i}].hash`, message: `Hash must be a SHA256 digest (64 hex chars) — got "${hash}".`, code: 'INVALID_HASH' })
    } else {
      const key = hash.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].hash`, message: `Hash ${hash} is listed more than once; the last one wins.`, code: 'DUPLICATE_HASH' })
      } else {
        seen.add(key)
      }
    }

    if (!HASH_LIST_TYPES.has(listType)) {
      errors.push({ field: `items[${i}].list_type`, message: `List type must be one of allowlist, blocklist (got "${listType}").`, code: 'INVALID_LIST_TYPE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
