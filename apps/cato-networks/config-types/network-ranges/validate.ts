import type { CanvasSnapshot, PipelineContext, ValidationError, ValidationResult, ValidationWarning } from '@veltrixsecops/app-sdk'
import { items } from '../lib/catoPolicy'

const IP_RANGE_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}-\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

export interface NetworkRangeSpec {
  name: string
  description: string
  ipRange: string
}

/** Extract one Global IP Range spec per canvas item. */
export function extractNetworkRangeSpecs(canvas: CanvasSnapshot): NetworkRangeSpec[] {
  return items(canvas).map((item) => {
    const fields = item.fields ?? {}
    return {
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      ipRange: typeof fields.ipRange === 'string' ? fields.ipRange.trim() : '',
    }
  })
}

/** Build the create/update body (add and update share the same shape here; `id` is layered on for update). */
export function buildNetworkRangeBody(spec: NetworkRangeSpec): Record<string, unknown> {
  return { name: spec.name, description: spec.description || undefined, ipRange: spec.ipRange }
}

function octetsInRange(ip: string): boolean {
  return ip.split('.').every((part) => {
    const n = Number(part)
    return Number.isInteger(n) && n >= 0 && n <= 255
  })
}

/**
 * Validate Network Range items. Static only - no target access:
 *   - name is required, <= 255 chars, and unique within the canvas
 *   - ipRange is required and must be a well-formed "a.b.c.d-e.f.g.h" range
 *     with every octet 0-255
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractNetworkRangeSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else {
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate network range "${spec.name}" - each may only be declared once.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
    }

    if (!spec.ipRange) {
      errors.push({ field: `${prefix}.ipRange`, message: 'IP Range is required.', code: 'EMPTY_IP_RANGE' })
    } else if (!IP_RANGE_RE.test(spec.ipRange)) {
      errors.push({ field: `${prefix}.ipRange`, message: 'IP Range must be formatted as "a.b.c.d-e.f.g.h".', code: 'INVALID_IP_RANGE_FORMAT' })
    } else {
      const [from, to] = spec.ipRange.split('-')
      if (!octetsInRange(from) || !octetsInRange(to)) {
        errors.push({ field: `${prefix}.ipRange`, message: 'IP Range octets must each be between 0 and 255.', code: 'INVALID_IP_RANGE_OCTET' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
