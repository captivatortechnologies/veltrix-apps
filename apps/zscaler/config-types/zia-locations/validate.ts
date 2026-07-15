import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Locations constraints -----------------------------------------------

/** ZIA caps a location name at 128 characters. */
export const MAX_LOCATION_NAME_LENGTH = 128

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface LocationSpec {
  sectionName: string
  /** The location name — its logical identity (list + match). */
  name: string
  /** Country code/name (first-class convenience field). */
  country?: string
  /** Timezone (first-class convenience field). */
  tz?: string
  /**
   * Raw JSON object string for the many optional location fields ZIA supports
   * (ipAddresses, ports, authRequired, sslScanEnabled, vpnCredentials, …).
   * Absent/blank = only the first-class fields are managed.
   */
  locationJson?: string
}

/**
 * Shape of a location returned by GET /locations. A location has many
 * server-managed fields, so this keeps the identity fields typed and allows any
 * additional key (used to capture/restore the whole prior object in rollback).
 */
export interface LiveLocation {
  id?: number
  name?: string
  country?: string
  tz?: string
  [key: string]: unknown
}

/** Each canvas item describes one ZIA location. */
export function extractLocationSpecs(canvas: CanvasSnapshot): LocationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const country =
      typeof fields.country === 'string' && fields.country.trim() ? fields.country.trim() : undefined
    const tz = typeof fields.tz === 'string' && fields.tz.trim() ? fields.tz.trim() : undefined
    const locationJson =
      typeof fields.location_json === 'string' && fields.location_json.trim()
        ? fields.location_json.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      country,
      tz,
      locationJson,
    }
  })
}

/**
 * Parse the raw location_json string, returning the object or null when the
 * string is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 */
export function parseLocationObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate location configurations against ZIA constraints: a name is required
 * and capped at 128 chars, any location_json must parse to a JSON object, and
 * the name — a location's logical identity — must be unique across the canvas
 * (matched case-insensitively, since ZIA rejects locations differing only in
 * case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractLocationSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Location name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_LOCATION_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Location name must be ${MAX_LOCATION_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate location "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_location',
        })
      }
      seen.add(key)
    }

    // location_json — optional; when present it must parse as a JSON object.
    if (spec.locationJson && parseLocationObject(spec.locationJson) === null) {
      errors.push({
        field: `${prefix}.location_json`,
        message:
          'Location settings must be a valid JSON object, e.g. {"ipAddresses":["1.2.3.4"],"authRequired":true} — leave blank for name-only',
        code: 'invalid_location_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
