import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { hasAnyAssignment, type AssignmentSpec } from '../../lib/assignments'

/** The @odata.type of a Windows quality update (expedite) profile — its own top-level collection. */
export const QUALITY_UPDATE_PROFILE_ODATA_TYPE = '#microsoft.graph.windowsQualityUpdateProfile'

/**
 * The @odata.type of the nested expedited-settings complex type. Verbatim per the
 * Graph beta docs, which emit it WITHOUT a leading '#' (unlike the top-level type).
 */
export const EXPEDITED_SETTINGS_ODATA_TYPE = 'microsoft.graph.expeditedWindowsQualityUpdateSettings'

/** Intune caps the forced-reboot grace at 0-2 days for an expedited quality update. */
export const DAYS_UNTIL_FORCED_REBOOT_MIN = 0
export const DAYS_UNTIL_FORCED_REBOOT_MAX = 2

export interface QualityUpdateProfileSpec {
  sectionName: string
  name: string
  description: string
  /** The KB / release identifier of the released quality update to expedite. */
  qualityUpdateRelease: string
  /** Undefined when left blank (left unmanaged → the Intune default applies). */
  daysUntilForcedReboot?: number
  assignments: AssignmentSpec
}

/** The profile display name is the reconciliation key. */
export function profileKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Read a tags/list field into a trimmed string array (accepts a comma/newline string too). */
function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(/[\n,]/).map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/** Parse a number field; undefined when blank/non-numeric (so it is left unmanaged). */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Parse a checkbox field; undefined when unset. */
function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'on' || v === 'yes') return true
    if (v === 'false' || v === 'off' || v === 'no' || v === '') return false
  }
  return undefined
}

// hasAnyAssignment lives once in lib/assignments (imported above); re-exported here
// for this type's deploy/drift/tests that import it from ./validate.
export { hasAnyAssignment }

/** Each canvas item is one quality update profile: name + release/reboot settings + assignments. */
export function extractProfileSpecs(canvas: CanvasSnapshot): QualityUpdateProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.profile_name === 'string' ? fields.profile_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      qualityUpdateRelease: typeof fields.qualityUpdateRelease === 'string' ? fields.qualityUpdateRelease.trim() : '',
      daysUntilForcedReboot: readNumber(fields.daysUntilForcedReboot),
      assignments: {
        includeGroupIds: readList(fields.includeGroups),
        excludeGroupIds: readList(fields.excludeGroups),
        allDevices: readBool(fields.allDevices) ?? false,
        allUsers: readBool(fields.allUsers) ?? false,
      },
    }
  })
}

/** Build the nested expeditedUpdateSettings object (daysUntilForcedReboot omitted when unmanaged). */
export function buildExpeditedSettings(spec: QualityUpdateProfileSpec): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    '@odata.type': EXPEDITED_SETTINGS_ODATA_TYPE,
    qualityUpdateRelease: spec.qualityUpdateRelease,
  }
  if (spec.daysUntilForcedReboot !== undefined) settings.daysUntilForcedReboot = spec.daysUntilForcedReboot
  return settings
}

/** Build the create/PATCH body — the @odata.type subtype is carried on both. */
export function buildProfileBody(spec: QualityUpdateProfileSpec): Record<string, unknown> {
  return {
    '@odata.type': QUALITY_UPDATE_PROFILE_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
    expeditedUpdateSettings: buildExpeditedSettings(spec),
  }
}

/**
 * Validate quality update profiles: each needs a unique name and a release to
 * expedite; daysUntilForcedReboot, when set, must be within 0-2. A profile with no
 * assignment target is warned (it would expedite the update on no devices).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no quality update profile items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.profile_name`, message: 'Profile name is required', code: 'required' })
    } else {
      const key = profileKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.profile_name`, message: `Duplicate profile name "${spec.name}"`, code: 'duplicate_profile' })
      }
      seen.add(key)
    }

    if (!spec.qualityUpdateRelease) {
      errors.push({
        field: `${prefix}.qualityUpdateRelease`,
        message: 'A quality update release to expedite is required',
        code: 'required',
      })
    }

    if (spec.daysUntilForcedReboot !== undefined) {
      const v = spec.daysUntilForcedReboot
      if (!Number.isInteger(v) || v < DAYS_UNTIL_FORCED_REBOOT_MIN || v > DAYS_UNTIL_FORCED_REBOOT_MAX) {
        errors.push({
          field: `${prefix}.daysUntilForcedReboot`,
          message: `Days until forced reboot must be a whole number between ${DAYS_UNTIL_FORCED_REBOOT_MIN} and ${DAYS_UNTIL_FORCED_REBOOT_MAX}`,
          code: 'out_of_range',
        })
      }
    }

    if (!hasAnyAssignment(spec.assignments)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: 'Profile has no assignment — add include groups or target all devices, or it will expedite on nothing',
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
