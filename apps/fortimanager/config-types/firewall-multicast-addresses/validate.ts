import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall multicast address constraints ---------------------

export const MAX_NAME_LENGTH = 79
export const MULTICAST_TYPES = ['multicastrange', 'broadcastmask'] as const

export interface MulticastAddressSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** multicastrange | broadcastmask. */
  type: string
  /** First IP of the multicast range (multicastrange type). */
  startIp: string
  /** Last IP of the multicast range (multicastrange type). */
  endIp: string
  /** CIDR for the broadcast subnet (broadcastmask type). */
  subnetCidr: string
  /** Interface the address applies to (default "any"). */
  associatedInterface: string
  comment: string
}

/** A multicast address as returned by a get on the multicast-address table. */
export interface LiveMulticastAddress {
  name?: string
  type?: string | number
  'start-ip'?: string
  'end-ip'?: string
  /** subnet is a ["ip","mask"] array on the wire (sometimes a string). */
  subnet?: string[] | string
  'associated-interface'?: string | string[]
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/

export function isValidIpv4(value: string): boolean {
  const m = IPV4.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

export function isValidCidr(value: string): boolean {
  const m = IPV4_CIDR.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

/** Convert "a.b.c.d/n" to the ["ip", "dotted-mask"] array FortiManager expects. */
export function cidrToIpMask(cidr: string): [string, string] {
  const [ip, prefixRaw] = cidr.split('/')
  const prefix = Number(prefixRaw ?? '32')
  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const mask = [24, 16, 8, 0].map((s) => (maskInt >>> s) & 0xff).join('.')
  return [ip, mask]
}

/** Normalize a scalar that may echo back as a single-element array. */
export function normalizeScalar(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim()
  return ''
}

/** Normalize a live subnet (["ip","mask"] array or "ip mask" string) to "ip mask". */
export function normalizeSubnet(v: LiveMulticastAddress['subnet']): string {
  if (Array.isArray(v)) return v.join(' ').trim()
  return asString(v)
}

export function extractMulticastAddressSpecs(canvas: CanvasSnapshot): MulticastAddressSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'multicastrange').toLowerCase(),
      startIp: asString(f.startIp),
      endIp: asString(f.endIp),
      subnetCidr: asString(f.subnetCidr),
      associatedInterface: asString(f.associatedInterface),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractMulticastAddressSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate multicast address "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(MULTICAST_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${MULTICAST_TYPES.join(', ')}`, code: 'invalid_type' })
      return
    }

    if (spec.type === 'multicastrange') {
      if (!isValidIpv4(spec.startIp)) {
        errors.push({ field: `${prefix}.startIp`, message: 'A multicastrange address needs a valid start IP', code: 'invalid_ip' })
      }
      if (!isValidIpv4(spec.endIp)) {
        errors.push({ field: `${prefix}.endIp`, message: 'A multicastrange address needs a valid end IP', code: 'invalid_ip' })
      }
    } else if (spec.type === 'broadcastmask') {
      if (!spec.subnetCidr) {
        errors.push({ field: `${prefix}.subnetCidr`, message: 'A broadcastmask address needs a subnet in CIDR form', code: 'missing_subnet' })
      } else if (!isValidCidr(spec.subnetCidr)) {
        errors.push({ field: `${prefix}.subnetCidr`, message: `"${spec.subnetCidr}" is not a valid IPv4 CIDR (e.g. 10.0.0.0/24)`, code: 'invalid_cidr' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
