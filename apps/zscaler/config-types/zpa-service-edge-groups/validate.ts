import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ServiceEdgeGroupSpec {
  sectionName: string
  /** The service edge group name — its logical identity (list + match). */
  name: string
  description?: string
  enabled: boolean
  /** Human-readable geographic location (required). */
  location: string
  /** Latitude/longitude sent to ZPA as decimal strings. */
  latitude: string
  longitude: string
  countryCode?: string
  versionProfileId: string
  upgradeDay: string
  upgradeTimeInSecs: string
}

/** Shape of a service edge group returned by GET /serviceEdgeGroup. */
export interface LiveServiceEdgeGroup {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  location?: string
  latitude?: string
  longitude?: string
  countryCode?: string
  versionProfileId?: string
  upgradeDay?: string
  upgradeTimeInSecs?: string
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a text field, trimming and falling back to `fallback` when empty. */
export function readText(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return fallback
}

/** Each canvas item describes one ZPA service edge group. */
export function extractServiceEdgeGroupSpecs(canvas: CanvasSnapshot): ServiceEdgeGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const countryCode =
      typeof fields.country_code === 'string' && fields.country_code.trim()
        ? fields.country_code.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      enabled: readBool(fields.enabled, true),
      location: typeof fields.location === 'string' ? fields.location.trim() : '',
      latitude: typeof fields.latitude === 'string' ? fields.latitude.trim() : '',
      longitude: typeof fields.longitude === 'string' ? fields.longitude.trim() : '',
      countryCode,
      versionProfileId: readText(fields.version_profile_id, '0'),
      upgradeDay: readText(fields.upgrade_day, 'SUNDAY'),
      upgradeTimeInSecs: readText(fields.upgrade_time_in_secs, '66600'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate service edge group configurations: name, location, latitude and
 * longitude are required, and the name is unique across the canvas (matched
 * case-insensitively — ZPA rejects groups differing only in case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServiceEdgeGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service edge group name is required', code: 'required' })
      continue
    }
    if (spec.name.length > 255) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Service edge group name must be 255 characters or fewer',
        code: 'max_length',
      })
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

    const key = spec.name.toLowerCase()
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate service edge group "${spec.name}" — each name may only be declared once per canvas`,
        code: 'duplicate_service_edge_group',
      })
    }
    seen.add(key)
  }

  return { valid: errors.length === 0, errors, warnings }
}
