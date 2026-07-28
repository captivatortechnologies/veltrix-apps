import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { hasAnyAssignment, type AssignmentSpec } from '../../lib/assignments'

/** The @odata.type of a Windows feature update profile (its OWN top-level collection). */
export const WINDOWS_FEATURE_UPDATE_PROFILE_ODATA_TYPE = '#microsoft.graph.windowsFeatureUpdateProfile'

/** The @odata.type of the rollout complex type embedded in a profile. */
export const WINDOWS_UPDATE_ROLLOUT_SETTINGS_ODATA_TYPE = '#microsoft.graph.windowsUpdateRolloutSettings'

type ProfileFieldType = 'string' | 'boolean'

interface ProfileFieldDef {
  /** Canvas field key — kept identical to the Graph property for a trivial mapping. */
  key: string
  label: string
  type: ProfileFieldType
}

/**
 * The writable scalar Graph fields this profile manages (rollout is a complex type
 * handled separately). The canvas key equals the Graph property, so
 * extract/deploy/drift all key off this one list (DRY).
 */
export const PROFILE_FIELDS: ProfileFieldDef[] = [
  { key: 'featureUpdateVersion', label: 'Feature update version', type: 'string' },
  {
    key: 'installLatestWindows10OnWindows11IneligibleDevice',
    label: 'Install latest Windows 10 on Windows 11-ineligible devices',
    type: 'boolean',
  },
]

/** The gradual-rollout window declared on the canvas (all optional). */
export interface RolloutSpec {
  startDate?: string
  endDate?: string
  intervalInDays?: number
}

export interface FeatureUpdateProfileSpec {
  sectionName: string
  name: string
  description: string
  /** Only the writable scalar Graph fields the user set, keyed by Graph property. */
  graph: Record<string, unknown>
  rollout: RolloutSpec
  assignments: AssignmentSpec
}

/** The profile name is the reconciliation key. */
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
export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/** Parse a checkbox field; undefined when unset. */
export function readBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'on' || v === 'yes') return true
    if (v === 'false' || v === 'off' || v === 'no' || v === '') return false
  }
  return undefined
}

/** Read a trimmed string, undefined when blank. */
function readText(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

/** Normalize a datetime for comparison: ISO when parseable, else the lowercased literal. */
export function normalizeDateTime(value: unknown): string {
  if (value === undefined || value === null) return ''
  const s = String(value).trim()
  if (s === '') return ''
  const t = Date.parse(s)
  return Number.isNaN(t) ? s.toLowerCase() : new Date(t).toISOString()
}

/** True when at least one rollout field is declared (drives rolloutSettings emission). */
export function hasAnyRollout(rollout: RolloutSpec): boolean {
  return Boolean(rollout.startDate) || Boolean(rollout.endDate) || rollout.intervalInDays !== undefined
}

/**
 * Build the rolloutSettings complex type from the declared window; undefined when
 * nothing is declared (so the profile makes the update available immediately).
 * Unset offer fields are sent as null (a partial window is valid — e.g. a start
 * date only, or a full gradual rollout with start/end/interval).
 */
export function buildRolloutSettings(rollout: RolloutSpec): Record<string, unknown> | undefined {
  if (!hasAnyRollout(rollout)) return undefined
  return {
    '@odata.type': WINDOWS_UPDATE_ROLLOUT_SETTINGS_ODATA_TYPE,
    offerStartDateTimeInUTC: rollout.startDate ?? null,
    offerEndDateTimeInUTC: rollout.endDate ?? null,
    offerIntervalInDays: rollout.intervalInDays ?? null,
  }
}

/** Read the three offer fields off a live profile's rolloutSettings (for drift/rollback). */
export function readRolloutSettings(
  rolloutSettings: unknown,
): { offerStartDateTimeInUTC: unknown; offerEndDateTimeInUTC: unknown; offerIntervalInDays: unknown } {
  const rs = (rolloutSettings ?? {}) as Record<string, unknown>
  return {
    offerStartDateTimeInUTC: rs.offerStartDateTimeInUTC ?? null,
    offerEndDateTimeInUTC: rs.offerEndDateTimeInUTC ?? null,
    offerIntervalInDays: rs.offerIntervalInDays ?? null,
  }
}

// hasAnyAssignment lives once in lib/assignments (imported above); re-exported here
// for this type's deploy/drift/tests that import it from ./validate.
export { hasAnyAssignment }

/** Each canvas item is one feature update profile: name + writable fields + rollout + assignments. */
export function extractProfileSpecs(canvas: CanvasSnapshot): FeatureUpdateProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const graph: Record<string, unknown> = {}
    for (const def of PROFILE_FIELDS) {
      const raw = fields[def.key]
      if (def.type === 'boolean') {
        const b = readBool(raw)
        if (b !== undefined) graph[def.key] = b
      } else {
        const s = readText(raw)
        if (s !== undefined) graph[def.key] = s
      }
    }
    return {
      sectionName: section.name,
      name: typeof fields.profile_name === 'string' ? fields.profile_name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      graph,
      rollout: {
        startDate: readText(fields.rolloutStartDate),
        endDate: readText(fields.rolloutEndDate),
        intervalInDays: readNumber(fields.rolloutIntervalInDays),
      },
      assignments: {
        includeGroupIds: readList(fields.includeGroups),
        excludeGroupIds: readList(fields.excludeGroups),
        allDevices: readBool(fields.allDevices) ?? false,
        allUsers: readBool(fields.allUsers) ?? false,
      },
    }
  })
}

/** Build the create/PATCH body — the @odata.type subtype + required featureUpdateVersion. */
export function buildProfileBody(spec: FeatureUpdateProfileSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    '@odata.type': WINDOWS_FEATURE_UPDATE_PROFILE_ODATA_TYPE,
    displayName: spec.name,
    description: spec.description,
    roleScopeTagIds: ['0'],
    ...spec.graph,
  }
  const rollout = buildRolloutSettings(spec.rollout)
  if (rollout) body.rolloutSettings = rollout
  return body
}

/**
 * Validate feature update profiles: each needs a unique name and a target feature
 * version. Rollout dates must be parseable and the end must be after the start; a
 * gradual interval without a start/end window is warned. A profile with no
 * assignment target is warned (it would apply to no devices).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no feature update profile items', code: 'empty_canvas' })
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

    if (!spec.graph.featureUpdateVersion) {
      errors.push({
        field: `${prefix}.featureUpdateVersion`,
        message: 'Feature update version is required (e.g. "Windows 11, version 23H2")',
        code: 'required',
      })
    }

    const { startDate, endDate, intervalInDays } = spec.rollout
    if (startDate !== undefined && Number.isNaN(Date.parse(startDate))) {
      errors.push({ field: `${prefix}.rolloutStartDate`, message: 'Rollout start date is not a valid date/time', code: 'invalid_datetime' })
    }
    if (endDate !== undefined && Number.isNaN(Date.parse(endDate))) {
      errors.push({ field: `${prefix}.rolloutEndDate`, message: 'Rollout end date is not a valid date/time', code: 'invalid_datetime' })
    }
    if (
      startDate !== undefined &&
      endDate !== undefined &&
      !Number.isNaN(Date.parse(startDate)) &&
      !Number.isNaN(Date.parse(endDate)) &&
      Date.parse(endDate) <= Date.parse(startDate)
    ) {
      errors.push({ field: `${prefix}.rolloutEndDate`, message: 'Rollout end date must be after the start date', code: 'rollout_window' })
    }
    if (intervalInDays !== undefined && intervalInDays < 1) {
      errors.push({ field: `${prefix}.rolloutIntervalInDays`, message: 'Rollout interval (days) must be at least 1', code: 'out_of_range' })
    }
    if (intervalInDays !== undefined && (startDate === undefined || endDate === undefined)) {
      warnings.push({
        field: `${prefix}.rolloutIntervalInDays`,
        message: 'A gradual rollout interval needs both a start and an end date to define the offer window',
        code: 'gradual_rollout_incomplete',
      })
    }

    if (!hasAnyAssignment(spec.assignments)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: 'Profile has no assignment — add include groups or target all devices, or it will apply to nothing',
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
