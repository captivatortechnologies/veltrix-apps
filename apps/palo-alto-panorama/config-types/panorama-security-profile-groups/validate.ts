import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { PanoramaEntry, UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/SecurityProfileGroups'

/**
 * The security-profile categories a group can reference. Each maps a canvas
 * field key to the PAN-OS REST element name; every category holds a single
 * profile name wrapped as a one-member list.
 */
export const PROFILE_CATEGORIES = [
  { field: 'virus', element: 'virus', label: 'antivirus' },
  { field: 'spyware', element: 'spyware', label: 'anti-spyware' },
  { field: 'vulnerability', element: 'vulnerability', label: 'vulnerability' },
  { field: 'url_filtering', element: 'url-filtering', label: 'url-filtering' },
  { field: 'file_blocking', element: 'file-blocking', label: 'file-blocking' },
  { field: 'wildfire_analysis', element: 'wildfire-analysis', label: 'wildfire-analysis' },
  { field: 'data_filtering', element: 'data-filtering', label: 'data-filtering' },
] as const

export interface SecurityProfileGroupSpec {
  sectionName: string
  name: string
  /** element name -> referenced profile name, only for categories that are set. */
  profiles: Record<string, string>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractSecurityProfileGroupSpecs(canvas: CanvasSnapshot): SecurityProfileGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const profiles: Record<string, string> = {}
    for (const cat of PROFILE_CATEGORIES) {
      const value = str(fields[cat.field])
      if (value) profiles[cat.element] = value
    }
    return { sectionName: section.name, name: str(fields.name), profiles }
  })
}

/** Build the REST entry fields — each referenced profile becomes a one-member list. */
export function buildSecurityProfileGroupFields(spec: SecurityProfileGroupSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [element, profileName] of Object.entries(spec.profiles)) {
    fields[element] = { member: [profileName] }
  }
  return fields
}

export function securityProfileGroupUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractSecurityProfileGroupSpecs(canvas)
    .filter((s) => s.name)
    .map((s) => ({ name: s.name, fields: buildSecurityProfileGroupFields(s) }))
}

function firstMember(value: unknown): string {
  if (value && typeof value === 'object' && Array.isArray((value as { member?: unknown[] }).member)) {
    const members = (value as { member: unknown[] }).member
    return members.length > 0 ? str(members[0]) : ''
  }
  return ''
}

export function securityProfileGroupDriftDiffs(spec: SecurityProfileGroupSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  for (const cat of PROFILE_CATEGORIES) {
    const expected = spec.profiles[cat.element] ?? ''
    const actual = firstMember(entry[cat.element])
    if (expected !== actual) {
      diffs.push({
        field: `${spec.name}.${cat.element}`,
        expected: expected || 'not set',
        actual: actual || 'not set',
        severity: 'warning',
      })
    }
  }
  return diffs
}

/**
 * Validate security profile groups: a name is required and unique across the
 * canvas. Referenced profiles are all optional, but a group with no profiles at
 * all is flagged as a warning (it would enforce nothing).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractSecurityProfileGroupSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Security profile group name is required', code: 'required' })
    }
    if (Object.keys(spec.profiles).length === 0) {
      warnings.push({ field: `${prefix}.profiles`, message: 'This group references no profiles — it will enforce nothing', code: 'empty_group' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate security profile group "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
