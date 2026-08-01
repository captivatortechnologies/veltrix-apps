import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  MAX_NAME_LENGTH,
  MAX_PREFIX,
  MIN_PREFIX,
  extractNetworkSpecs,
  isIpv4,
} from './_shared'

/**
 * Validate network items: a unique non-empty name within the length limit, a
 * valid IPv4 address (required unless the network is dynamic), and a prefix
 * length in 0–32. Static — no target access required.
 */
export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractNetworkSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one network.', code: 'EMPTY' })
  }

  const seenNames = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate network "${spec.name}" — each may only be declared once per canvas.`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (spec.isDynamic) {
      if (spec.ipAddress && !isIpv4(spec.ipAddress)) {
        errors.push({
          field: `${prefix}.ipAddress`,
          message: `"${spec.ipAddress}" is not a valid IPv4 address.`,
          code: 'invalid_ip',
        })
      }
    } else if (!spec.ipAddress) {
      errors.push({
        field: `${prefix}.ipAddress`,
        message: 'IP address is required for a static network (or mark it dynamic).',
        code: 'required',
      })
    } else if (!isIpv4(spec.ipAddress)) {
      errors.push({
        field: `${prefix}.ipAddress`,
        message: `"${spec.ipAddress}" is not a valid IPv4 address.`,
        code: 'invalid_ip',
      })
    }

    if (!Number.isInteger(spec.prefixLength) || spec.prefixLength < MIN_PREFIX || spec.prefixLength > MAX_PREFIX) {
      errors.push({
        field: `${prefix}.prefixLength`,
        message: `Prefix length must be an integer between ${MIN_PREFIX} and ${MAX_PREFIX} (got ${spec.prefixLength}).`,
        code: 'invalid_prefix',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
