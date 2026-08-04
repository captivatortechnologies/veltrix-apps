import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate match-enablement items. Static — no target access required.
 *   - device_serial is required and doubles as the identity (duplicates warned).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one sensor.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const deviceSerial = String(item.fields.device_serial ?? '').trim()

    if (!deviceSerial) {
      errors.push({ field: `items[${i}].device_serial`, message: 'Device serial is required.', code: 'EMPTY_DEVICE_SERIAL' })
    } else if (seen.has(deviceSerial)) {
      warnings.push({
        field: `items[${i}].device_serial`,
        message: `Device serial "${deviceSerial}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_DEVICE_SERIAL',
      })
    } else {
      seen.add(deviceSerial)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
