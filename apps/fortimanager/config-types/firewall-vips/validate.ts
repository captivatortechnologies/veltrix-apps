import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall virtual IP (IPv4, static-nat) constraints ---------

export const MAX_NAME_LENGTH = 79
/** Bound v1 to the widely-used static-nat DNAT (with optional port forwarding). */
export const VIP_TYPE = 'static-nat'
export const VIP_PROTOCOLS = ['tcp', 'udp', 'sctp', 'icmp'] as const

export interface VipSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** External interface name (e.g. "any" or "port1"). */
  extintf: string
  /** External IP or "start-end" range that receives the traffic. */
  extip: string
  /** Internal mapped IP or "start-end" range — sent as a string on set. */
  mappedip: string
  /** disable | enable — port forwarding. */
  portforward: string
  /** tcp | udp | sctp | icmp — only meaningful with port forwarding. */
  protocol: string
  extport: string
  mappedport: string
  /** disable | enable — reply to ARP for the external IP. */
  arpReply: string
  comment: string
}

/** A VIP as returned by a get on the vip table. `mappedip`/`extip` may echo back
 *  as a list-of-objects [{range:"..."}] on some FMG builds — normalize on read. */
export interface LiveVip {
  name?: string
  type?: string | number
  extintf?: string | string[]
  extip?: string | Array<string | { range?: string }>
  mappedip?: string | Array<string | { range?: string }>
  extport?: string
  mappedport?: string
  portforward?: string
  protocol?: string | number
  'arp-reply'?: string
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

/** Accept a single IPv4 or an "ip-ip" range. */
export function isValidIpOrRange(value: string): boolean {
  if (!value) return false
  if (value.includes('-')) {
    const [a, b] = value.split('-')
    return isValidIpv4((a ?? '').trim()) && isValidIpv4((b ?? '').trim())
  }
  return isValidIpv4(value)
}

/** Normalize a VIP IP field (string, [string] or [{range}]) to a plain string. */
export function normalizeVipIp(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v)) {
    const first = v[0]
    if (typeof first === 'string') return first.trim()
    if (first && typeof first === 'object' && typeof (first as { range?: unknown }).range === 'string') {
      return (first as { range: string }).range.trim()
    }
  }
  return ''
}

/** Normalize a scalar that may echo back as a single-element array (e.g. extintf). */
export function normalizeScalar(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim()
  return ''
}

export function extractVipSpecs(canvas: CanvasSnapshot): VipSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      extintf: asString(f.extintf) || 'any',
      extip: asString(f.extip),
      mappedip: asString(f.mappedip),
      portforward: (asString(f.portforward) || 'disable').toLowerCase(),
      protocol: (asString(f.protocol) || 'tcp').toLowerCase(),
      extport: asString(f.extport),
      mappedport: asString(f.mappedport),
      arpReply: (asString(f.arpReply) || 'enable').toLowerCase(),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractVipSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate virtual IP "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!isValidIpOrRange(spec.extip)) {
      errors.push({ field: `${prefix}.extip`, message: 'A virtual IP needs a valid external IP or "start-end" range', code: 'invalid_extip' })
    }
    if (!isValidIpOrRange(spec.mappedip)) {
      errors.push({ field: `${prefix}.mappedip`, message: 'A virtual IP needs a valid mapped IP or "start-end" range', code: 'invalid_mappedip' })
    }

    if (spec.portforward === 'enable') {
      if (!(VIP_PROTOCOLS as readonly string[]).includes(spec.protocol)) {
        errors.push({ field: `${prefix}.protocol`, message: `Protocol must be one of: ${VIP_PROTOCOLS.join(', ')}`, code: 'invalid_protocol' })
      }
      if (!spec.extport) {
        errors.push({ field: `${prefix}.extport`, message: 'Port forwarding needs an external port', code: 'missing_extport' })
      }
      if (!spec.mappedport) {
        errors.push({ field: `${prefix}.mappedport`, message: 'Port forwarding needs a mapped port', code: 'missing_mappedport' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
