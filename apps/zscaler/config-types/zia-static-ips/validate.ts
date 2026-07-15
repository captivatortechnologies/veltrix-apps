import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Static IPs constraints ----------------------------------------------

/** ZIA caps a static IP comment at 10240 characters. */
export const MAX_STATIC_IP_COMMENT_LENGTH = 10240
/** Valid WGS84 coordinate bounds used when a geo override is supplied. */
export const MIN_LATITUDE = -90
export const MAX_LATITUDE = 90
export const MIN_LONGITUDE = -180
export const MAX_LONGITUDE = 180

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface StaticIpSpec {
  sectionName: string
  /** The public IP address — its logical identity (list + match by ipAddress). */
  ipAddress: string
  /** Optional free-text comment. */
  comment?: string
  /** Whether the author overrides the geolocation derived from the IP. */
  geoOverride: boolean
  /** Latitude for the geo override (only meaningful when geoOverride is true). */
  latitude?: number
  /** Longitude for the geo override (only meaningful when geoOverride is true). */
  longitude?: number
  /** Whether the IP is publicly routable (ZIA defaults this true). */
  routableIp: boolean
}

/** Shape of a static IP returned by GET /staticIP. */
export interface LiveStaticIp {
  id?: number
  ipAddress?: string
  comment?: string
  geoOverride?: boolean
  latitude?: number
  longitude?: number
  routableIP?: boolean
}

/** Coerce a canvas boolean field, falling back when unset (booleans may arrive as strings). */
export function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

/** Coerce a canvas number field, returning undefined when unset/blank/non-numeric (numbers may arrive as strings). */
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const n = Number(trimmed)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Each canvas item describes one ZIA static IP. */
export function extractStaticIpSpecs(canvas: CanvasSnapshot): StaticIpSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const comment =
      typeof fields.comment === 'string' && fields.comment.trim() ? fields.comment.trim() : undefined
    return {
      sectionName: section.name,
      ipAddress: typeof fields.ip_address === 'string' ? fields.ip_address.trim() : '',
      comment,
      geoOverride: readBoolean(fields.geo_override, false),
      latitude: readNumber(fields.latitude),
      longitude: readNumber(fields.longitude),
      // ZIA defaults a static IP to routable; keep that unless the author turns it off.
      routableIp: readBoolean(fields.routable_ip, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate static IP configurations against ZIA constraints: an IP address is
 * required and — a static IP's logical identity — must be unique across the
 * canvas (matched case-insensitively). When a geo override is enabled, both a
 * latitude and a longitude are required and, if supplied, must fall within the
 * valid WGS84 coordinate bounds.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractStaticIpSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.ipAddress) {
      errors.push({ field: `${prefix}.ip_address`, message: 'Static IP address is required', code: 'required' })
    } else {
      const key = spec.ipAddress.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.ip_address`,
          message: `Duplicate static IP "${spec.ipAddress}" — each IP address may only be declared once per canvas`,
          code: 'duplicate_static_ip',
        })
      }
      seen.add(key)
    }

    if (spec.comment && spec.comment.length > MAX_STATIC_IP_COMMENT_LENGTH) {
      errors.push({
        field: `${prefix}.comment`,
        message: `Comment must be ${MAX_STATIC_IP_COMMENT_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // A geo override replaces the geolocation ZIA derives from the IP, so both
    // coordinates must be supplied together.
    if (spec.geoOverride) {
      if (spec.latitude === undefined) {
        errors.push({
          field: `${prefix}.latitude`,
          message: 'Latitude is required when geo override is enabled',
          code: 'required',
        })
      }
      if (spec.longitude === undefined) {
        errors.push({
          field: `${prefix}.longitude`,
          message: 'Longitude is required when geo override is enabled',
          code: 'required',
        })
      }
    }

    if (spec.latitude !== undefined && (spec.latitude < MIN_LATITUDE || spec.latitude > MAX_LATITUDE)) {
      errors.push({
        field: `${prefix}.latitude`,
        message: `Latitude must be between ${MIN_LATITUDE} and ${MAX_LATITUDE}`,
        code: 'out_of_range',
      })
    }
    if (spec.longitude !== undefined && (spec.longitude < MIN_LONGITUDE || spec.longitude > MAX_LONGITUDE)) {
      errors.push({
        field: `${prefix}.longitude`,
        message: `Longitude must be between ${MIN_LONGITUDE} and ${MAX_LONGITUDE}`,
        code: 'out_of_range',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
