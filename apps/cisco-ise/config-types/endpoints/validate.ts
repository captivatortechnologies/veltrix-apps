import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_DESCRIPTION_LENGTH, isValidMac, specFromItem } from './_shared'

/**
 * Validate endpoint items: a non-empty, valid, uniquely-identified MAC
 * address within ERS's length limits. Static — no target access (the
 * referenced endpoint identity group, if any, is resolved live in deploy.ts).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one endpoint.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const rawMac = String(item.fields.mac ?? '').trim()
    const spec = specFromItem(item)

    if (!rawMac) {
      errors.push({ field: `items[${i}].mac`, message: 'MAC address is required.', code: 'EMPTY_MAC' })
    } else if (!isValidMac(rawMac)) {
      errors.push({ field: `items[${i}].mac`, message: `"${rawMac}" is not a valid MAC address (expected AA:BB:CC:DD:EE:FF).`, code: 'INVALID_MAC' })
    } else {
      const key = spec.mac
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].mac`, message: `MAC "${spec.mac}" is listed more than once; the last one wins.`, code: 'DUPLICATE_MAC' })
      } else {
        seen.add(key)
      }
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
