import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractQueueSpecs, isValidMask, queueKey, type QueueSpec } from './_shared'

/**
 * Validate OPNsense traffic-shaper-queues configurations: a required,
 * unique (case-insensitive) description, a required target pipe name (the
 * live uuid is resolved at deploy time, not verified here — see the module
 * doc), a weight in [1,100], and a supported mask.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: QueueSpec[] = extractQueueSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    } else {
      const key = queueKey(spec.description)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.description`,
          message: `Duplicate queue "${spec.description}" — each description may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!spec.pipeName) {
      errors.push({ field: `${prefix}.pipe_name`, message: 'A target pipe name is required', code: 'required' })
    }
    if (!Number.isInteger(spec.weight) || spec.weight < 1 || spec.weight > 100) {
      errors.push({ field: `${prefix}.weight`, message: 'Weight must be an integer between 1 and 100', code: 'invalid_value' })
    }
    if (!isValidMask(spec.mask)) {
      errors.push({ field: `${prefix}.mask`, message: `Mask must be one of none, src-ip, dst-ip, src-ip6, dst-ip6 (got "${spec.mask}")`, code: 'invalid_value' })
    }
    if (spec.codelEnable && spec.pieEnable) {
      errors.push({ field: `${prefix}.pie_enable`, message: 'CoDel and PIE cannot both be enabled', code: 'conflicting_value' })
    }
    if (spec.buckets != null && (spec.buckets < 1 || spec.buckets > 65535)) {
      errors.push({ field: `${prefix}.buckets`, message: 'Buckets must be between 1 and 65535', code: 'invalid_value' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
