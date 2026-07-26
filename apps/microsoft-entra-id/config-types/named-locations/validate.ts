import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra Named Locations constraints ---------------------------------------

export const MAX_NAME_LENGTH = 256
export const LOCATION_TYPES = ['ip', 'country'] as const

// --- Spec extraction shared by deploy / rollback / driftDetect / healthCheck --

export interface NamedLocationSpec {
  sectionName: string
  /** Stable canvas item id — survives renames; used to match a live location by
   *  the external id stored from the prior deploy. */
  itemId?: string
  /** displayName — the logical identity live locations are matched on. */
  name: string
  /** 'ip' | 'country'. */
  type: string
  /** IPv4/IPv6 CIDR ranges (ip locations). */
  ipRanges: string[]
  isTrusted: boolean
  /** ISO 3166 country/region codes (country locations). */
  countries: string[]
  includeUnknown: boolean
}

/** A named location as returned by Graph GET /identity/conditionalAccess/namedLocations. */
export interface LiveNamedLocation {
  id?: string
  '@odata.type'?: string
  displayName?: string
  isTrusted?: boolean
  ipRanges?: Array<{ '@odata.type'?: string; cidrAddress?: string }>
  countriesAndRegions?: string[]
  includeUnknownCountriesAndRegions?: boolean
}

export const IP_ODATA_TYPE = '#microsoft.graph.ipNamedLocation'
export const COUNTRY_ODATA_TYPE = '#microsoft.graph.countryNamedLocation'

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Split a textarea/text value into trimmed, non-empty tokens (by newline or comma). */
function splitTokens(v: unknown): string[] {
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function extractNamedLocationSpecs(canvas: CanvasSnapshot): NamedLocationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      sectionName: item.name,
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: (asString(f.type) || 'ip').toLowerCase(),
      ipRanges: splitTokens(f.ipRanges),
      isTrusted: asBool(f.isTrusted),
      countries: splitTokens(f.countries).map((c) => c.toUpperCase()),
      includeUnknown: asBool(f.includeUnknown),
    }
  })
}

const IPV4_CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/
const IPV6_CIDR = /^[0-9a-fA-F:]+\/(\d|[1-9]\d|1[01]\d|12[0-8])$/
const ISO_COUNTRY = /^[A-Z]{2}$/

export function isValidCidr(value: string): boolean {
  const m = IPV4_CIDR.exec(value)
  if (m) {
    return [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
  }
  return IPV6_CIDR.test(value)
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractNamedLocationSpecs(ctx.canvas)
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
          message: `Duplicate named location "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required, enum
    if (!(LOCATION_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type must be one of: ${LOCATION_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
      return
    }

    // type-specific definition
    if (spec.type === 'ip') {
      if (spec.ipRanges.length === 0) {
        errors.push({
          field: `${prefix}.ipRanges`,
          message: 'An IP named location needs at least one CIDR range',
          code: 'missing_ranges',
        })
      } else {
        spec.ipRanges.forEach((cidr, r) => {
          if (!isValidCidr(cidr)) {
            errors.push({
              field: `${prefix}.ipRanges[${r}]`,
              message: `"${cidr}" is not a valid IPv4/IPv6 CIDR range`,
              code: 'invalid_cidr',
            })
          }
        })
      }
      if (spec.countries.length > 0) {
        warnings.push({
          field: `${prefix}.countries`,
          message: 'Countries are ignored for an IP named location',
          code: 'ignored_field',
        })
      }
    } else {
      // country
      if (spec.countries.length === 0) {
        errors.push({
          field: `${prefix}.countries`,
          message: 'A country named location needs at least one ISO country/region code',
          code: 'missing_countries',
        })
      } else {
        spec.countries.forEach((code, c) => {
          if (!ISO_COUNTRY.test(code)) {
            errors.push({
              field: `${prefix}.countries[${c}]`,
              message: `"${code}" is not a valid ISO 3166 two-letter code`,
              code: 'invalid_country',
            })
          }
        })
      }
      if (spec.ipRanges.length > 0) {
        warnings.push({
          field: `${prefix}.ipRanges`,
          message: 'IP ranges are ignored for a country named location',
          code: 'ignored_field',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
