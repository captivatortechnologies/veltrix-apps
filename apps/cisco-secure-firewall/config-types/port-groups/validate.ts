import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's gen/definitions/port_group.yaml `rest_endpoint`.
export const PORT_GROUPS_PATH = '/object/portobjectgroups'

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface PortGroupSpec {
  sectionName: string
  name: string
  memberNames: string[]
  description: string
  overridable: boolean
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function coerceBool(value: unknown, def: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return def
}

export function extractPortGroupSpecs(canvas: CanvasSnapshot): PortGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      memberNames: splitList(fields.member_names),
      description: str(fields.description),
      overridable: coerceBool(fields.overridable, false),
    }
  })
}

export function buildPortGroupBaseFields(spec: PortGroupSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { overridable: spec.overridable }
  if (spec.description) fields.description = spec.description
  return fields
}

/** Validate port groups: a valid name and at least one member are required; names are unique. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractPortGroupSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    } else if (!NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'FMC object names allow letters, numbers, periods, underscores and hyphens only - no spaces',
        code: 'invalid_name',
      })
    }

    if (spec.memberNames.length === 0) {
      errors.push({ field: `${prefix}.member_names`, message: 'At least one member is required', code: 'required' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate group "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
