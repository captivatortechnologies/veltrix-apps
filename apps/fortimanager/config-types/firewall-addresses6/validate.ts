import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager firewall IPv6 address (address6) constraints ---------------

export const MAX_NAME_LENGTH = 79
/** The clean, name-keyed address6 subtypes. nsx / dynamic / template need SDN or
 *  template dependencies and are intentionally not offered. */
export const ADDRESS6_TYPES = ['ipprefix', 'iprange', 'fqdn'] as const

export interface Address6Spec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** ipprefix | iprange | fqdn. */
  type: string
  /** IPv6 prefix for ipprefix, e.g. 2001:db8::/32. */
  ip6: string
  /** First IPv6 address for iprange. */
  startIp: string
  /** Final IPv6 address for iprange. */
  endIp: string
  /** Fully-qualified domain name for fqdn. */
  fqdn: string
  comment: string
}

/** An IPv6 address as returned by a get on the address6 table. */
export interface LiveAddress6 {
  name?: string
  type?: string | number
  ip6?: string
  'start-ip'?: string
  'end-ip'?: string
  fqdn?: string
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Loose IPv6 validation — accepts full and :: -compressed forms (no embedded IPv4). */
export function isValidIpv6(value: string): boolean {
  const v = value.trim()
  if (!v || !/^[0-9a-fA-F:]+$/.test(v)) return false
  const parts = v.split('::')
  if (parts.length > 2) return false
  const groups = (s: string): string[] => (s === '' ? [] : s.split(':'))
  const all = [...groups(parts[0]), ...(parts.length === 2 ? groups(parts[1]) : [])]
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false
  }
  return parts.length === 2 ? all.length <= 7 : all.length === 8
}

/** Validate an IPv6 prefix in "address/prefix-length" form. */
export function isValidIpv6Prefix(value: string): boolean {
  const bits = value.split('/')
  if (bits.length !== 2) return false
  const prefix = Number(bits[1])
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false
  return isValidIpv6(bits[0])
}

export function extractAddress6Specs(canvas: CanvasSnapshot): Address6Spec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'ipprefix').toLowerCase(),
      ip6: asString(f.ip6),
      startIp: asString(f.startIp),
      endIp: asString(f.endIp),
      fqdn: asString(f.fqdn),
      comment: asString(f.comment),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAddress6Specs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate address "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(ADDRESS6_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${ADDRESS6_TYPES.join(', ')}`, code: 'invalid_type' })
      return
    }

    if (spec.type === 'ipprefix') {
      if (!spec.ip6) {
        errors.push({ field: `${prefix}.ip6`, message: 'An ipprefix address needs an IPv6 prefix', code: 'missing_ip6' })
      } else if (!isValidIpv6Prefix(spec.ip6)) {
        errors.push({ field: `${prefix}.ip6`, message: `"${spec.ip6}" is not a valid IPv6 prefix (e.g. 2001:db8::/32)`, code: 'invalid_ip6' })
      }
    } else if (spec.type === 'iprange') {
      if (!isValidIpv6(spec.startIp)) {
        errors.push({ field: `${prefix}.startIp`, message: 'An iprange address needs a valid IPv6 start address', code: 'invalid_ip6' })
      }
      if (!isValidIpv6(spec.endIp)) {
        errors.push({ field: `${prefix}.endIp`, message: 'An iprange address needs a valid IPv6 end address', code: 'invalid_ip6' })
      }
    } else if (spec.type === 'fqdn') {
      if (!spec.fqdn) {
        errors.push({ field: `${prefix}.fqdn`, message: 'An fqdn address needs a domain name', code: 'missing_fqdn' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
