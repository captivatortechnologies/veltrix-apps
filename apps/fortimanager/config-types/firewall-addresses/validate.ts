import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall address constraints -------------------------------

export const MAX_NAME_LENGTH = 79
export const ADDRESS_TYPES = ['ipmask', 'iprange', 'fqdn', 'geography'] as const

export interface AddressSpec {
  itemId?: string
  /** name — the mkey / identity FortiManager objects are matched on. */
  name: string
  /** ipmask | iprange | fqdn | geography. */
  type: string
  /** CIDR for ipmask, e.g. 10.0.100.0/24. */
  subnetCidr: string
  startIp: string
  endIp: string
  fqdn: string
  /** ISO 3166 two-letter country code for geography. */
  country: string
  comment: string
}

/** A firewall address as returned by a get on the address table. */
export interface LiveAddress {
  name?: string
  type?: string | number
  /** subnet is a ["ip","mask"] array on the wire (sometimes a string). */
  subnet?: string[] | string
  'start-ip'?: string
  'end-ip'?: string
  fqdn?: string
  country?: string
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAddressSpecs(canvas: CanvasSnapshot): AddressSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'ipmask').toLowerCase(),
      subnetCidr: asString(f.subnetCidr),
      startIp: asString(f.startIp),
      endIp: asString(f.endIp),
      fqdn: asString(f.fqdn),
      country: asString(f.country).toUpperCase(),
      comment: asString(f.comment),
    }
  })
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/
const ISO_COUNTRY = /^[A-Z]{2}$/

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

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAddressSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // name — required, length, uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate address "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — enum
    if (!(ADDRESS_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type must be one of: ${ADDRESS_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
      return
    }

    // type-specific required fields
    if (spec.type === 'ipmask') {
      if (!spec.subnetCidr) {
        errors.push({ field: `${prefix}.subnetCidr`, message: 'An ipmask address needs a subnet in CIDR form', code: 'missing_subnet' })
      } else if (!isValidCidr(spec.subnetCidr)) {
        errors.push({ field: `${prefix}.subnetCidr`, message: `"${spec.subnetCidr}" is not a valid IPv4 CIDR (e.g. 10.0.0.0/24)`, code: 'invalid_cidr' })
      }
    } else if (spec.type === 'iprange') {
      if (!isValidIpv4(spec.startIp)) {
        errors.push({ field: `${prefix}.startIp`, message: 'An iprange address needs a valid start IP', code: 'invalid_ip' })
      }
      if (!isValidIpv4(spec.endIp)) {
        errors.push({ field: `${prefix}.endIp`, message: 'An iprange address needs a valid end IP', code: 'invalid_ip' })
      }
    } else if (spec.type === 'fqdn') {
      if (!spec.fqdn) {
        errors.push({ field: `${prefix}.fqdn`, message: 'An fqdn address needs a domain name', code: 'missing_fqdn' })
      }
    } else if (spec.type === 'geography') {
      if (!ISO_COUNTRY.test(spec.country)) {
        errors.push({ field: `${prefix}.country`, message: 'A geography address needs an ISO 3166 two-letter country code', code: 'invalid_country' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
