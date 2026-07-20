import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Device Assurance API constraints -----------------------------------
//
// A device assurance policy defines per-platform device posture requirements. Its
// logical identity is its NAME. Endpoints:
//   GET/POST      /device-assurances        — list / create
//   GET/PUT/DEL   /device-assurances/{id}   — get / replace / delete
// There is NO lifecycle (no activate/deactivate). `platform` is the discriminator
// and is immutable after creation. A policy mapped to an Authentication Policy
// returns 409 on delete until it is unmapped.

/** The five device platforms Okta device assurance supports. */
export const DEVICE_PLATFORMS = ['ANDROID', 'CHROMEOS', 'IOS', 'MACOS', 'WINDOWS'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

/** Device assurance policy name cap. */
export const MAX_DEVICE_ASSURANCE_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DeviceAssuranceSpec {
  sectionName: string
  /** Policy name — the logical identity deploy matches on. */
  name: string
  /** Target platform — ANDROID | CHROMEOS | IOS | MACOS | WINDOWS (immutable). */
  platform: string
  /** Raw JSON string of the platform-specific requirements. */
  configJson?: string
}

/** Shape of a device assurance policy returned by GET /device-assurances. */
export interface LiveDeviceAssurance {
  id?: string
  name?: string
  platform?: string
  createdBy?: string
  createdDate?: string
  lastUpdate?: string
  lastUpdatedBy?: string
  _links?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too).
 */
export function parseConfigObject(raw: string): Record<string, unknown> | null {
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

/** Each canvas item describes one Okta device assurance policy. */
export function extractDeviceAssuranceSpecs(canvas: CanvasSnapshot): DeviceAssuranceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const configJson =
      typeof fields.configJson === 'string' && fields.configJson.trim()
        ? fields.configJson.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      // platform is an upper-case enum; normalise so a lower-case entry matches.
      platform: typeof fields.platform === 'string' ? fields.platform.trim().toUpperCase() : '',
      configJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate device-assurance-policy configurations against the Okta Device
 * Assurance API. Static only — it never contacts Okta:
 *   - name is required, <= 255 chars, unique within the canvas
 *   - platform is one of ANDROID | CHROMEOS | IOS | MACOS | WINDOWS
 *   - configJson is required, parses to a JSON OBJECT, and carries at least one
 *     requirement (Okta rejects an empty policy)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDeviceAssuranceSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 255 chars, unique
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DEVICE_ASSURANCE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_DEVICE_ASSURANCE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each device assurance policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // platform — required and in the enum
    if (!spec.platform) {
      errors.push({ field: `${prefix}.platform`, message: 'Platform is required', code: 'required' })
    } else if (!(DEVICE_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${DEVICE_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // configJson — required, a JSON object, with at least one requirement
    const config = spec.configJson ? parseConfigObject(spec.configJson) : null
    if (!spec.configJson) {
      errors.push({ field: `${prefix}.configJson`, message: 'Requirements (JSON) is required', code: 'required' })
    } else if (config === null) {
      errors.push({
        field: `${prefix}.configJson`,
        message: 'Requirements must be a valid JSON object, e.g. {"screenLockType":{"include":["PASSCODE"]}}',
        code: 'invalid_config',
      })
    } else if (Object.keys(config).length === 0) {
      errors.push({
        field: `${prefix}.configJson`,
        message: 'A device assurance policy needs at least one requirement',
        code: 'missing_requirement',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
