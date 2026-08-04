import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isValidIpv4, isValidIpv6, objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export interface AddressRangeSpec {
  itemId?: string
  /** name — the identity Check Point address-range objects are matched on. */
  name: string
  ipv4First: string
  ipv4Last: string
  ipv6First: string
  ipv6Last: string
  comments: string
  color: string
  tags: string[]
}

/** An address-range object as returned by show-address-range / show-address-ranges. */
export interface LiveAddressRange {
  uid?: string
  name?: string
  'ipv4-address-first'?: string
  'ipv4-address-last'?: string
  'ipv6-address-first'?: string
  'ipv6-address-last'?: string
  comments?: string
  color?: string
  tags?: Array<string | { name?: string }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const addressRangeKey = objectKey

export function extractAddressRangeSpecs(canvas: CanvasSnapshot): AddressRangeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      ipv4First: asString(f.ipv4First),
      ipv4Last: asString(f.ipv4Last),
      ipv6First: asString(f.ipv6First),
      ipv6Last: asString(f.ipv6Last),
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

/** Compare two dotted-decimal IPv4 addresses. Assumes both are already valid. */
export function compareIpv4(a: string, b: string): number {
  const toInt = (ip: string) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0)
  return toInt(a) - toInt(b)
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point address-range configurations: a name is required and
 * unique across the canvas (case-insensitive); at least one complete
 * (first, last) pair — IPv4 and/or IPv6 — is required, each endpoint must be
 * a valid address, and an IPv4 range's first must not be after its last
 * (a straightforward, verifiable check; the equivalent IPv6 numeric
 * comparison is not implemented — see README).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAddressRangeSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = addressRangeKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate address range "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    const hasV4 = !!(spec.ipv4First || spec.ipv4Last)
    const hasV6 = !!(spec.ipv6First || spec.ipv6Last)
    if (!hasV4 && !hasV6) {
      errors.push({
        field: `${prefix}.ipv4First`,
        message: 'An address range needs a complete IPv4 and/or IPv6 first/last pair',
        code: 'required',
      })
    }

    if (hasV4) {
      if (!spec.ipv4First || !isValidIpv4(spec.ipv4First)) {
        errors.push({ field: `${prefix}.ipv4First`, message: 'A valid IPv4 first address is required', code: 'invalid_ip' })
      }
      if (!spec.ipv4Last || !isValidIpv4(spec.ipv4Last)) {
        errors.push({ field: `${prefix}.ipv4Last`, message: 'A valid IPv4 last address is required', code: 'invalid_ip' })
      }
      if (spec.ipv4First && spec.ipv4Last && isValidIpv4(spec.ipv4First) && isValidIpv4(spec.ipv4Last)) {
        if (compareIpv4(spec.ipv4First, spec.ipv4Last) > 0) {
          errors.push({
            field: `${prefix}.ipv4Last`,
            message: `IPv4 first address "${spec.ipv4First}" is after last address "${spec.ipv4Last}"`,
            code: 'invalid_range',
          })
        }
      }
    }

    if (hasV6) {
      if (!spec.ipv6First || !isValidIpv6(spec.ipv6First)) {
        errors.push({ field: `${prefix}.ipv6First`, message: 'A valid IPv6 first address is required', code: 'invalid_ip' })
      }
      if (!spec.ipv6Last || !isValidIpv6(spec.ipv6Last)) {
        errors.push({ field: `${prefix}.ipv6Last`, message: 'A valid IPv6 last address is required', code: 'invalid_ip' })
      }
    }

    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
