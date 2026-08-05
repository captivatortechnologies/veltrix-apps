import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SOPHOS_ALLOWED_ITEM_TYPES } from '../../lib/sophosApi'
import { allowedItemKey, extractAllowedItemSpecs } from './_shared'

const SHA256_RE = /^[A-Fa-f0-9]{64}$/

/**
 * Validate allowed item(s): a known `type`, a required `value` (checked
 * against the SHA256 shape when type is "sha256"), a required `comment`, and
 * uniqueness per (type, value). Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one allowed item.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAllowedItemSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Match By type is required.', code: 'REQUIRED' })
    } else if (!(SOPHOS_ALLOWED_ITEM_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `"${spec.type}" must be one of ${SOPHOS_ALLOWED_ITEM_TYPES.join(', ')}.`,
        code: 'INVALID_TYPE',
      })
    }

    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Value is required.', code: 'REQUIRED' })
    } else if (spec.type === 'sha256' && !SHA256_RE.test(spec.value)) {
      errors.push({ field: `${prefix}.value`, message: `"${spec.value}" is not a 64-character hexadecimal SHA256 checksum.`, code: 'INVALID_SHA256' })
    }

    if (!spec.comment) {
      errors.push({ field: `${prefix}.comment`, message: 'A comment explaining why this item is allowed is required.', code: 'REQUIRED' })
    }

    if (spec.type && spec.value) {
      const key = allowedItemKey(spec.type, spec.value)
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.value`,
          message: `"${spec.value}" (type "${spec.type}") is listed more than once; the last one wins.`,
          code: 'DUPLICATE_ITEM',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
