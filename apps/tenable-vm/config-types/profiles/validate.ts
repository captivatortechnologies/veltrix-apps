import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Profiles API constraints -----------------------------------------

/**
 * Tenable does not publish a hard profile-name length; 255 is a conservative,
 * defensive cap that comfortably admits any realistic profile name while
 * keeping the field bounded (mirrors the exclusions name cap).
 */
export const MAX_PROFILE_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ProfileSpec {
  sectionName: string
  /** Profile name — the profile's logical identity. */
  name: string
  /** Raw settingsJson string; absent/blank = a name-only profile. */
  settingsJson?: string
}

/** Shape of a profile returned by GET /profiles and GET /profiles/{id}. */
export interface LiveProfile {
  id?: number | string
  uuid?: string
  name?: string
  /** Tuning fields are tenant-/version-specific — keep the shape open. */
  [key: string]: unknown
}

/** Each canvas section describes one Tenable profile. */
export function extractProfileSpecs(canvas: CanvasSnapshot): ProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const settingsJson =
      typeof fields.settingsJson === 'string' && fields.settingsJson.trim()
        ? fields.settingsJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
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
 * Validate profile configurations against the (conservatively modelled)
 * Profiles API: a name is required and bounded, any advanced settings must be a
 * JSON object, and the name — a profile's logical identity — must be unique
 * within the canvas. No tuning field names are validated because none are
 * prescribed (settingsJson is intentionally freeform).
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
  const seenNames = new Set<string>()

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

    // settingsJson — optional; when present it must parse as a JSON object
    if (spec.settingsJson && parseSettingsObject(spec.settingsJson) === null) {
      errors.push({
        field: `${prefix}.settingsJson`,
        message:
          'Advanced settings must be a valid JSON object, e.g. {"max_scan_time_hours": 4} — leave blank for a name-only profile',
        code: 'invalid_settings',
      })
    }

    // name is the profile's logical identity — dedupe on it. Matched exactly
    // (not case-folded): Tenable stores the name as a literal string, so two
    // names differing only in case are distinct profiles.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate profile "${spec.name}" — each profile name may only be declared once per canvas`,
          code: 'duplicate_profile',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
