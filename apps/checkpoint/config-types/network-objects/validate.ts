import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isValidIpv6, objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface NetworkSpec {
  itemId?: string
  /** name — the identity Check Point network objects are matched on. */
  name: string
  subnetCidr: string
  subnet6Cidr: string
  comments: string
  color: string
  tags: string[]
}

/** A network object as returned by show-network / show-networks. */
export interface LiveNetwork {
  uid?: string
  name?: string
  subnet4?: string
  'mask-length4'?: number
  subnet6?: string
  'mask-length6'?: number
  comments?: string
  color?: string
  tags?: Array<string | { name?: string }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const networkKey = objectKey

export function extractNetworkSpecs(canvas: CanvasSnapshot): NetworkSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      subnetCidr: asString(f.subnetCidr),
      subnet6Cidr: asString(f.subnet6Cidr),
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

// --- CIDR validation / parsing ---------------------------------------------------

const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/

export function isValidIpv4Cidr(value: string): boolean {
  const m = IPV4_CIDR_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

/** Split "10.0.0.0/24" into add-network's separate subnet4 + mask-length4 fields. */
export function parseIpv4Cidr(cidr: string): { subnet4: string; maskLength4: number } | null {
  if (!isValidIpv4Cidr(cidr)) return null
  const [subnet4, prefix] = cidr.split('/')
  return { subnet4, maskLength4: Number(prefix) }
}

export function isValidIpv6Cidr(value: string): boolean {
  const idx = value.lastIndexOf('/')
  if (idx < 0) return false
  const addr = value.slice(0, idx)
  const prefix = value.slice(idx + 1)
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > 128) return false
  return isValidIpv6(addr)
}

/** Split "2001:db8::/32" into add-network's separate subnet6 + mask-length6 fields. */
export function parseIpv6Cidr(cidr: string): { subnet6: string; maskLength6: number } | null {
  if (!isValidIpv6Cidr(cidr)) return null
  const idx = cidr.lastIndexOf('/')
  return { subnet6: cidr.slice(0, idx), maskLength6: Number(cidr.slice(idx + 1)) }
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point network-object configurations: a name is required and
 * unique across the canvas (case-insensitive); at least one of IPv4 / IPv6
 * subnet CIDR must be set, and whichever is set must be a valid CIDR.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNetworkSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = networkKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate network "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!spec.subnetCidr && !spec.subnet6Cidr) {
      errors.push({
        field: `${prefix}.subnetCidr`,
        message: 'A network needs an IPv4 and/or an IPv6 subnet in CIDR form',
        code: 'required',
      })
    }
    if (spec.subnetCidr && !isValidIpv4Cidr(spec.subnetCidr)) {
      errors.push({
        field: `${prefix}.subnetCidr`,
        message: `"${spec.subnetCidr}" is not a valid IPv4 CIDR (e.g. 10.0.0.0/24)`,
        code: 'invalid_cidr',
      })
    }
    if (spec.subnet6Cidr && !isValidIpv6Cidr(spec.subnet6Cidr)) {
      errors.push({
        field: `${prefix}.subnet6Cidr`,
        message: `"${spec.subnet6Cidr}" is not a valid IPv6 CIDR (e.g. 2001:db8::/32)`,
        code: 'invalid_cidr',
      })
    }
    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
