import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { LOCATIONS, NETWORK_TYPES, extractRemoteNetworkSpecs, networkKey } from './_shared'

/**
 * Validate Twingate Remote Network configurations: name is required and must
 * be unique across the canvas (case-insensitive); `location` and
 * `network_type` must be supported enum values. Purely static: no live
 * Twingate calls.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRemoteNetworkSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.itemName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Remote Network name is required', code: 'required' })
    }
    if (!LOCATIONS.includes(spec.location as (typeof LOCATIONS)[number])) {
      errors.push({ field: `${prefix}.location`, message: `Unsupported location "${spec.location}"`, code: 'invalid_location' })
    }
    if (!NETWORK_TYPES.includes(spec.networkType as (typeof NETWORK_TYPES)[number])) {
      errors.push({
        field: `${prefix}.network_type`,
        message: `Unsupported network type "${spec.networkType}"`,
        code: 'invalid_network_type',
      })
    }

    if (spec.name) {
      const key = networkKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Remote Network "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_network',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
