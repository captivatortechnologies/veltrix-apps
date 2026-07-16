import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { memberList, sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/AddressGroups'

export const GROUP_TYPES = ['static', 'dynamic'] as const
export type GroupType = (typeof GROUP_TYPES)[number]

export interface AddressGroupSpec {
  sectionName: string
  name: string
  groupType: string
  members: string[]
  dynamicFilter: string
}

export interface LiveAddressGroup extends PanoramaEntry {
  static?: { member?: string[] }
  dynamic?: { filter?: string }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractAddressGroupSpecs(canvas: CanvasSnapshot): AddressGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      groupType: str(fields.group_type) || 'static',
      members: splitList(fields.members),
      dynamicFilter: str(fields.dynamic_filter),
    }
  })
}

/** Build the REST entry fields for an address group. */
export function buildAddressGroupFields(spec: AddressGroupSpec): Record<string, unknown> {
  if (spec.groupType === 'dynamic') {
    return { dynamic: { filter: spec.dynamicFilter } }
  }
  return { static: memberList(spec.members) ?? { member: [] } }
}

export function addressGroupUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractAddressGroupSpecs(canvas)
    .filter((s) => s.name && GROUP_TYPES.includes(s.groupType as GroupType))
    .filter((s) => (s.groupType === 'dynamic' ? s.dynamicFilter.length > 0 : s.members.length > 0))
    .map((s) => ({ name: s.name, fields: buildAddressGroupFields(s) }))
}

export function addressGroupDriftDiffs(spec: AddressGroupSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveAddressGroup
  if (spec.groupType === 'dynamic') {
    const liveFilter = str(live.dynamic?.filter)
    if (liveFilter !== spec.dynamicFilter) {
      diffs.push({ field: `${spec.name}.filter`, expected: spec.dynamicFilter, actual: liveFilter || 'not set', severity: 'warning' })
    }
  } else {
    const liveMembers = Array.isArray(live.static?.member) ? (live.static!.member as string[]) : []
    if (!sameSet(liveMembers, spec.members)) {
      diffs.push({ field: `${spec.name}.members`, expected: spec.members.join(', '), actual: liveMembers.join(', ') || 'none', severity: 'warning' })
    }
  }
  return diffs
}

/**
 * Validate address groups: a name and a supported group type are required; a
 * static group needs at least one member, a dynamic group needs a filter; the
 * name is unique across the canvas.
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
  for (const spec of extractAddressGroupSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Address group name is required', code: 'required' })
    }
    if (!GROUP_TYPES.includes(spec.groupType as GroupType)) {
      errors.push({ field: `${prefix}.group_type`, message: `Unsupported group type "${spec.groupType}"`, code: 'invalid_type' })
    } else if (spec.groupType === 'static' && spec.members.length === 0) {
      errors.push({ field: `${prefix}.members`, message: 'A static address group needs at least one member', code: 'required' })
    } else if (spec.groupType === 'dynamic' && !spec.dynamicFilter) {
      errors.push({ field: `${prefix}.dynamic_filter`, message: 'A dynamic address group needs a match filter', code: 'required' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate address group "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
