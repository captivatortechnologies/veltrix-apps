import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Illumio Core IP List constraints -----------------------------------------
// name: 1-255 chars (Terraform provider `nameValidation` — "between 1 to 255
// characters"). ip_ranges/fqdns: AtLeastOneOf (Terraform
// `AtLeastOneOf: []string{"ip_ranges", "fqdns"}`) — an IP list needs at least
// one member. Confirmed against:
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_ip_list.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/ip_list.go

export const MAX_NAME_LENGTH = 255

export interface IpRangeSpec {
  fromIp: string
  toIp?: string
  description?: string
  exclusion?: boolean
}

export interface FqdnSpec {
  fqdn: string
  description?: string
}

export interface IpListSpec {
  itemId?: string
  name: string
  description: string
  ipRanges: IpRangeSpec[]
  fqdns: FqdnSpec[]
  externalDataSet: string
  externalDataReference: string
  /** Set when ipRangesJson failed to parse — the raw parse error, surfaced by validate. */
  ipRangesError?: string
  /** Set when fqdnsJson failed to parse. */
  fqdnsError?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse a JSON-array textarea field. Blank -> empty array, no error. */
function parseJsonArray(raw: unknown): { value: Record<string, unknown>[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  return { value: parsed.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') }
}

export function extractIpListSpecs(canvas: CanvasSnapshot): IpListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const ipRangesParsed = parseJsonArray(f.ipRangesJson)
    const fqdnsParsed = parseJsonArray(f.fqdnsJson)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ipRanges: ipRangesParsed.value.map((r) => ({
        fromIp: asString(r.fromIp),
        toIp: asString(r.toIp) || undefined,
        description: asString(r.description) || undefined,
        exclusion: r.exclusion === true,
      })),
      fqdns: fqdnsParsed.value.map((r) => ({
        fqdn: asString(r.fqdn),
        description: asString(r.description) || undefined,
      })),
      externalDataSet: asString(f.externalDataSet),
      externalDataReference: asString(f.externalDataReference),
      ipRangesError: ipRangesParsed.error,
      fqdnsError: fqdnsParsed.error,
    }
  })
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

/** from_ip accepts a bare IPv4 address OR a CIDR (Terraform: `IsIPAddress` or `IsCIDR`). */
export function isValidFromIp(value: string): boolean {
  return isValidIpv4(value) || isValidCidr(value)
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIpListSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate IP list "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.ipRangesError) {
      errors.push({ field: `${prefix}.ipRangesJson`, message: `IP ranges ${spec.ipRangesError}`, code: 'invalid_json' })
    }
    if (spec.fqdnsError) {
      errors.push({ field: `${prefix}.fqdnsJson`, message: `FQDNs ${spec.fqdnsError}`, code: 'invalid_json' })
    }

    if (!spec.ipRangesError && !spec.fqdnsError && spec.ipRanges.length === 0 && spec.fqdns.length === 0) {
      errors.push({
        field: `${prefix}.ipRangesJson`,
        message: 'An IP list needs at least one IP range or FQDN',
        code: 'empty_members',
      })
    }

    spec.ipRanges.forEach((r, ri) => {
      const rPrefix = `${prefix}.ipRangesJson[${ri}]`
      if (!r.fromIp) {
        errors.push({ field: `${rPrefix}.fromIp`, message: 'from_ip is required', code: 'required' })
      } else if (!isValidFromIp(r.fromIp)) {
        errors.push({ field: `${rPrefix}.fromIp`, message: `"${r.fromIp}" is not a valid IPv4 address or CIDR`, code: 'invalid_ip' })
      }
      if (r.toIp && !isValidIpv4(r.toIp)) {
        errors.push({ field: `${rPrefix}.toIp`, message: `"${r.toIp}" is not a valid IPv4 address`, code: 'invalid_ip' })
      }
    })

    spec.fqdns.forEach((f, fi) => {
      if (!f.fqdn) {
        errors.push({ field: `${prefix}.fqdnsJson[${fi}].fqdn`, message: 'fqdn is required', code: 'required' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
