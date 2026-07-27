import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall IPv6 IP pool constraints --------------------------

export const MAX_NAME_LENGTH = 79

export interface IpPool6Spec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** First IPv6 address of the NAT pool range. */
  startIp: string
  /** Last IPv6 address of the NAT pool range. */
  endIp: string
  comment: string
}

/** An IPv6 IP pool as returned by a get on the ippool6 table. */
export interface LiveIpPool6 {
  name?: string
  startip?: string
  endip?: string
  comments?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

// Standard IPv6 matcher (full, compressed :: and IPv4-mapped forms).
const IPV6 =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/

export function isValidIpv6(value: string): boolean {
  return IPV6.test(value)
}

export function extractIpPool6Specs(canvas: CanvasSnapshot): IpPool6Spec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      startIp: asString(f.startIp),
      endIp: asString(f.endIp),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIpPool6Specs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate IPv6 pool "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!isValidIpv6(spec.startIp)) {
      errors.push({ field: `${prefix}.startIp`, message: 'An IPv6 pool needs a valid start IPv6 address', code: 'invalid_ip' })
    }
    if (!isValidIpv6(spec.endIp)) {
      errors.push({ field: `${prefix}.endIp`, message: 'An IPv6 pool needs a valid end IPv6 address', code: 'invalid_ip' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
