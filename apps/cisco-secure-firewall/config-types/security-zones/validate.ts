import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { FmcObject, UpsertSpec } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's gen/definitions/security_zone.yaml `rest_endpoint`.
export const SECURITY_ZONES_PATH = '/object/securityzones'

export const INTERFACE_TYPES = ['PASSIVE', 'INLINE', 'SWITCHED', 'ROUTED', 'ASA'] as const
export type InterfaceType = (typeof INTERFACE_TYPES)[number]

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

export interface SecurityZoneSpec {
  sectionName: string
  name: string
  interfaceType: string
  description: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractSecurityZoneSpecs(canvas: CanvasSnapshot): SecurityZoneSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      interfaceType: str(fields.interface_type) || 'ROUTED',
      description: str(fields.description),
    }
  })
}

export function buildSecurityZoneFields(spec: SecurityZoneSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { interfaceMode: spec.interfaceType }
  if (spec.description) fields.description = spec.description
  return fields
}

export function securityZoneUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractSecurityZoneSpecs(canvas)
    .filter((s) => s.name && INTERFACE_TYPES.includes(s.interfaceType as InterfaceType))
    .map((s) => ({ name: s.name, fields: buildSecurityZoneFields(s) }))
}

export function securityZoneDriftDiffs(spec: SecurityZoneSpec, live: FmcObject): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const liveMode = typeof live.interfaceMode === 'string' ? live.interfaceMode : ''
  if (liveMode && liveMode !== spec.interfaceType) {
    diffs.push({
      field: `${spec.name}.interface_type`,
      expected: spec.interfaceType,
      actual: liveMode,
      severity: 'warning',
    })
  }
  const liveDescription = typeof live.description === 'string' ? live.description : ''
  if (spec.description && liveDescription !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription || 'not set', severity: 'info' })
  }
  return diffs
}

/** Validate security zones: a valid name and a supported interface mode are required; names are unique. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractSecurityZoneSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Zone name is required', code: 'required' })
    } else if (!NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'FMC object names allow letters, numbers, periods, underscores and hyphens only - no spaces',
        code: 'invalid_name',
      })
    }

    if (!INTERFACE_TYPES.includes(spec.interfaceType as InterfaceType)) {
      errors.push({ field: `${prefix}.interface_type`, message: `Unsupported interface mode "${spec.interfaceType}"`, code: 'invalid_interface_type' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate zone "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
