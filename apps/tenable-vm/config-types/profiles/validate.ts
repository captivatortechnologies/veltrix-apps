import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Profiles API constraints -----------------------------------------
//
// Profiles live at GET/POST /sensors/profiles/{sensor_type} and GET/PUT/DELETE
// /sensors/profiles/{sensor_type}/{profile_uuid} — sensor_type is a REQUIRED
// path segment (enum "agent" | "scanners"; see developer.tenable.com/reference/
// profiles-create). There is no sensor-type-less /profiles endpoint.

/**
 * Tenable does not publish a hard profile-name length; 255 is a conservative,
 * defensive cap that comfortably admits any realistic profile name while
 * keeping the field bounded (mirrors the exclusions name cap).
 */
export const MAX_PROFILE_NAME_LENGTH = 255

/** sensor_type path-segment enum — literal values the API expects (note: "scanners", plural). */
export const SENSOR_TYPES = ['agent', 'scanners'] as const
export type SensorType = (typeof SENSOR_TYPES)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ProfileSpec {
  sectionName: string
  /** Profile name — the profile's logical identity (matched within its sensor type). */
  name: string
  /** "agent" | "scanners" — selects which Profiles endpoint this profile lives under. */
  sensorType: string
  description?: string
  /** Raw JSON string for the `config` object; absent/blank = a name-only profile. */
  settingsJson?: string
}

/**
 * Shape of a profile returned by GET /sensors/profiles/{sensor_type} (list) and
 * GET /sensors/profiles/{sensor_type}/{profile_uuid} (detail) — both use
 * `profile_uuid`. POST (create) instead returns a bare `uuid` (see
 * profileIdentifier, which checks both).
 */
export interface LiveProfile {
  profile_uuid?: string
  /** Present only on the POST create response. */
  uuid?: string
  name?: string
  description?: string
  created?: string
  updated?: string
  /** The tuning object; fields are tenant-/version-specific — keep it open. */
  config?: Record<string, unknown>
  [key: string]: unknown
}

/** Each canvas section describes one Tenable profile. */
export function extractProfileSpecs(canvas: CanvasSnapshot): ProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      sensorType: typeof fields.sensor_type === 'string' ? fields.sensor_type.trim() : '',
      description,
      settingsJson,
    }
  })
}

/**
 * Parse a raw settings string, returning the object or null when the string is
 * not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 */
export function parseSettingsObject(raw: string): Record<string, unknown> | null {
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
 * Validate profile configurations against the Profiles API
 * (developer.tenable.com/reference/profiles-create): a name is required and
 * bounded, sensor_type is required and must be "agent" or "scanners" (the
 * profile lives under that sensor type's own endpoint), any advanced config
 * must be a JSON object, and (name, sensor_type) — a profile's logical
 * identity — must be unique within the canvas. No `config` tuning field names
 * are validated because they vary by tenant/version (settingsJson maps
 * straight into the API's `config` object).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProfileSpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, bounded length
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Profile name is required', code: 'required' })
    } else if (spec.name.length > MAX_PROFILE_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Profile name must be ${MAX_PROFILE_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    // sensor_type — required + enum
    if (!spec.sensorType) {
      errors.push({
        field: `${prefix}.sensor_type`,
        message: 'Sensor type is required (Agent or Scanner)',
        code: 'required',
      })
    } else if (!(SENSOR_TYPES as readonly string[]).includes(spec.sensorType)) {
      errors.push({
        field: `${prefix}.sensor_type`,
        message: `Sensor type must be one of: ${SENSOR_TYPES.join(', ')}`,
        code: 'invalid_sensor_type',
      })
    }

    // settingsJson — optional; when present it must parse as a JSON object
    if (spec.settingsJson && parseSettingsObject(spec.settingsJson) === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message:
          'Advanced settings must be a valid JSON object, e.g. {"version": "10.7.1"} — leave blank for a name-only profile',
        code: 'invalid_settings',
      })
    }

    // (name, sensor_type) is the profile's logical identity — dedupe on it.
    // Matched exactly (not case-folded): Tenable stores the name as a literal
    // string, so two names differing only in case are distinct profiles. The
    // same name IS allowed once under "agent" and once under "scanners" — they
    // are different endpoints/objects.
    if (spec.name && spec.sensorType) {
      const key = JSON.stringify([spec.sensorType, spec.name])
      if (seenKeys.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate profile "${spec.name}" (${spec.sensorType}) — each name may only be declared once per sensor type per canvas`,
          code: 'duplicate_profile',
        })
      }
      seenKeys.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
