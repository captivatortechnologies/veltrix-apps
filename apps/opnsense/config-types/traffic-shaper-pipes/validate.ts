import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractPipeSpecs, isValidBandwidthMetric, isValidMask, isValidScheduler, pipeKey, type PipeSpec } from './_shared'

/**
 * Validate OPNsense traffic-shaper-pipes configurations: a required, unique
 * (case-insensitive) description (the model's own required field, used as
 * this app's identity), a positive bandwidth with a supported metric, and
 * supported mask/scheduler values.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: PipeSpec[] = extractPipeSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })
    } else {
      const key = pipeKey(spec.description)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.description`,
          message: `Duplicate pipe "${spec.description}" — each description may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!Number.isInteger(spec.bandwidth) || spec.bandwidth < 1) {
      errors.push({ field: `${prefix}.bandwidth`, message: 'Bandwidth must be a positive integer', code: 'invalid_value' })
    }
    if (!isValidBandwidthMetric(spec.bandwidthMetric)) {
      errors.push({
        field: `${prefix}.bandwidthMetric`,
        message: `Bandwidth metric must be one of bit, Kbit, Mbit, Gbit (got "${spec.bandwidthMetric}")`,
        code: 'invalid_value',
      })
    }
    if (!isValidMask(spec.mask)) {
      errors.push({ field: `${prefix}.mask`, message: `Mask must be one of none, src-ip, dst-ip, src-ip6, dst-ip6 (got "${spec.mask}")`, code: 'invalid_value' })
    }
    if (!isValidScheduler(spec.scheduler)) {
      errors.push({
        field: `${prefix}.scheduler`,
        message: `Scheduler must be blank (Weighted Fair Queueing) or one of fifo, rr, qfq, fq_codel, fq_pie (got "${spec.scheduler}")`,
        code: 'invalid_value',
      })
    }
    if (spec.codelEnable && spec.pieEnable) {
      errors.push({ field: `${prefix}.pie_enable`, message: 'CoDel and PIE cannot both be enabled', code: 'conflicting_value' })
    }
    if (spec.queue != null && (spec.queue < 2 || spec.queue > 100)) {
      errors.push({ field: `${prefix}.queue`, message: 'Queue size must be between 2 and 100', code: 'invalid_value' })
    }
    if (spec.buckets != null && (spec.buckets < 1 || spec.buckets > 65535)) {
      errors.push({ field: `${prefix}.buckets`, message: 'Buckets must be between 1 and 65535', code: 'invalid_value' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
