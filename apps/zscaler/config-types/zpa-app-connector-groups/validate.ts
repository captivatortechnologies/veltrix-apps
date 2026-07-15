import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZPA App Connector Group constraints --------------------------------------

/** ZPA caps an App Connector group name at 255 characters. */
export const MAX_GROUP_NAME_LENGTH = 255

/** Supported DNS query types for an App Connector group. */
export const DNS_QUERY_TYPES = ['IPV4_IPV6', 'IPV4', 'IPV6'] as const
export const DEFAULT_DNS_QUERY_TYPE = 'IPV4_IPV6'

/** ZPA version profile id — "0" is the built-in "Default" profile. */
export const DEFAULT_VERSION_PROFILE_ID = '0'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AppConnectorGroupSpec {
  sectionName: string
  /** The App Connector group name — its logical identity (list + match). */
  name: string
  description?: string
  enabled: boolean
  /** Geo location string (e.g. "San Jose, CA, USA"). */
  location: string
  /** Latitude — sent to ZPA as a string. */
  latitude: string
  /** Longitude — sent to ZPA as a string. */
  longitude: string
  countryCode?: string
  dnsQueryType: string
  versionProfileId: string
  cityCountry?: string
}

/** Shape of an App Connector group returned by GET /appConnectorGroup. */
export interface LiveAppConnectorGroup {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  location?: string
  latitude?: string | number
  longitude?: string | number
  countryCode?: string
  dnsQueryType?: string
  versionProfileId?: string
  cityCountry?: string
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a text field as a trimmed string (numbers are stringified). */
export function readText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Read an optional text field — undefined when blank. */
function optionalText(value: unknown): string | undefined {
  const text = readText(value)
  return text ? text : undefined
}

/** Read the DNS query type, falling back to the default for unknown values. */
function readDnsQueryType(value: unknown): string {
  const text = readText(value)
  return (DNS_QUERY_TYPES as readonly string[]).includes(text) ? text : DEFAULT_DNS_QUERY_TYPE
}

/** Each canvas item describes one ZPA App Connector group. */
export function extractAppConnectorGroupSpecs(canvas: CanvasSnapshot): AppConnectorGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readText(fields.name),
      description: optionalText(fields.description),
      enabled: readBool(fields.enabled, true),
      location: readText(fields.location),
      latitude: readText(fields.latitude),
      longitude: readText(fields.longitude),
      countryCode: optionalText(fields.country_code),
      dnsQueryType: readDnsQueryType(fields.dns_query_type),
      versionProfileId: readText(fields.version_profile_id) || DEFAULT_VERSION_PROFILE_ID,
      cityCountry: optionalText(fields.city_country),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate App Connector group configurations. A name is required, capped at 255
 * chars and unique across the canvas (matched case-insensitively — ZPA rejects
 * groups differing only in case). Location, latitude and longitude are required
 * because ZPA needs the geo coordinates to place the connector group on the map.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAppConnectorGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'App Connector group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `App Connector group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate App Connector group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_app_connector_group',
        })
      }
      seen.add(key)
    }

    if (!spec.location) {
      errors.push({ field: `${prefix}.location`, message: 'Location is required', code: 'required' })
    }
    if (!spec.latitude) {
      errors.push({ field: `${prefix}.latitude`, message: 'Latitude is required', code: 'required' })
    }
    if (!spec.longitude) {
      errors.push({ field: `${prefix}.longitude`, message: 'Longitude is required', code: 'required' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
