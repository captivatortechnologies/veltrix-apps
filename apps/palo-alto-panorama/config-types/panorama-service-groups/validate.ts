import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { sameSet, splitList, type PanoramaEntry, type UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/ServiceGroups'

export interface ServiceGroupSpec {
  sectionName: string
  name: string
  members: string[]
}

export interface LiveServiceGroup extends PanoramaEntry {
  members?: { member?: string[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractServiceGroupSpecs(canvas: CanvasSnapshot): ServiceGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      members: splitList(fields.members),
    }
  })
}

/** Build the REST entry fields for a service group (PAN-OS uses `members`). */
export function buildServiceGroupFields(spec: ServiceGroupSpec): Record<string, unknown> {
  return { members: { member: spec.members } }
}

export function serviceGroupUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractServiceGroupSpecs(canvas)
    .filter((s) => s.name && s.members.length > 0)
    .map((s) => ({ name: s.name, fields: buildServiceGroupFields(s) }))
}

export function serviceGroupDriftDiffs(spec: ServiceGroupSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveServiceGroup
  const liveMembers = Array.isArray(live.members?.member) ? (live.members!.member as string[]) : []
  if (!sameSet(liveMembers, spec.members)) {
    diffs.push({ field: `${spec.name}.members`, expected: spec.members.join(', '), actual: liveMembers.join(', ') || 'none', severity: 'warning' })
  }
  return diffs
}

/**
 * Validate service groups: a name and at least one member are required, and the
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
  for (const spec of extractServiceGroupSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service group name is required', code: 'required' })
    }
    if (spec.members.length === 0) {
      errors.push({ field: `${prefix}.members`, message: 'A service group needs at least one member', code: 'required' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate service group "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
