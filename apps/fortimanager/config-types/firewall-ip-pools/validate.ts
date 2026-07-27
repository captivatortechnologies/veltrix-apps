import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall IP pool (IPv4) constraints ------------------------

export const MAX_NAME_LENGTH = 79
/** Only the two range-only pool types are supported — both need just start/end IP.
 *  fixed-port-range / port-block-allocation carry extra required fields. */
export const IPPOOL_TYPES = ['overload', 'one-to-one'] as const

export interface IpPoolSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** overload | one-to-one. */
  type: string
  /** First IPv4 address of the NAT pool range. */
  startIp: string
  /** Last IPv4 address of the NAT pool range. */
  endIp: string
  comment: string
}

/** An IP pool as returned by a get on the ippool table. */
export interface LiveIpPool {
  name?: string
  type?: string | number
  startip?: string
  endip?: string
  comments?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

export function extractIpPoolSpecs(canvas: CanvasSnapshot): IpPoolSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'overload').toLowerCase(),
      startIp: asString(f.startIp),
      endIp: asString(f.endIp),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIpPoolSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate IP pool "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(IPPOOL_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${IPPOOL_TYPES.join(', ')}`, code: 'invalid_type' })
      return
    }

    if (!isValidIpv4(spec.startIp)) {
      errors.push({ field: `${prefix}.startIp`, message: 'An IP pool needs a valid start IP', code: 'invalid_ip' })
    }
    if (!isValidIpv4(spec.endIp)) {
      errors.push({ field: `${prefix}.endIp`, message: 'An IP pool needs a valid end IP', code: 'invalid_ip' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
