import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { FmcObject, UpsertSpec } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's gen/definitions/port.yaml `rest_endpoint`.
export const PORT_OBJECTS_PATH = '/object/protocolportobjects'

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/
const PORT_PATTERN = /^\d{1,5}(-\d{1,5})?$/

export interface PortObjectSpec {
  sectionName: string
  name: string
  protocol: string
  protocolOther: string
  port: string
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

/** The effective protocol value: the "Other" numeric override when selected, otherwise the picked value. */
export function effectiveProtocol(spec: PortObjectSpec): string {
  return spec.protocol === 'other' ? spec.protocolOther : spec.protocol
}

export function extractPortObjectSpecs(canvas: CanvasSnapshot): PortObjectSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      protocol: str(fields.protocol) || 'TCP',
      protocolOther: str(fields.protocol_other),
      port: str(fields.port),
      description: str(fields.description),
      overridable: coerceBool(fields.overridable, false),
    }
  })
}

export function buildPortObjectFields(spec: PortObjectSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { protocol: effectiveProtocol(spec), overridable: spec.overridable }
  if (spec.port) fields.port = spec.port
  if (spec.description) fields.description = spec.description
  return fields
}

export function portObjectUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractPortObjectSpecs(canvas)
    .filter((s) => s.name && effectiveProtocol(s))
    .map((s) => ({ name: s.name, fields: buildPortObjectFields(s) }))
}

export function portObjectDriftDiffs(spec: PortObjectSpec, live: FmcObject): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const liveProtocol = typeof live.protocol === 'string' ? live.protocol : ''
  const expectedProtocol = effectiveProtocol(spec)
  if (liveProtocol && liveProtocol.toUpperCase() !== expectedProtocol.toUpperCase()) {
    diffs.push({ field: `${spec.name}.protocol`, expected: expectedProtocol, actual: liveProtocol, severity: 'warning' })
  }
  const livePort = typeof live.port === 'string' ? live.port : ''
  if (spec.port && livePort !== spec.port) {
    diffs.push({ field: `${spec.name}.port`, expected: spec.port, actual: livePort || 'not set', severity: 'warning' })
  }
  return diffs
}

/**
 * Validate port objects: a valid name and a resolvable protocol are required
 * (a picked value, or a numeric IANA protocol number when "Other"); a port,
 * if given, is a single port or a "start-end" range. Names are unique.
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
  for (const spec of extractPortObjectSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Object name is required', code: 'required' })
    } else if (!NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'FMC object names allow letters, numbers, periods, underscores and hyphens only - no spaces',
        code: 'invalid_name',
      })
    }

    if (spec.protocol === 'other') {
      if (!spec.protocolOther || !/^\d+$/.test(spec.protocolOther)) {
        errors.push({ field: `${prefix}.protocol_other`, message: 'A numeric IANA protocol number is required when Protocol is "Other"', code: 'invalid_protocol' })
      }
    } else if (!spec.protocol) {
      errors.push({ field: `${prefix}.protocol`, message: 'Protocol is required', code: 'required' })
    }

    if (spec.port && !PORT_PATTERN.test(spec.port)) {
      errors.push({ field: `${prefix}.port`, message: 'Port must be a single number (0-65535) or a "start-end" range', code: 'invalid_port' })
    }

    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate object "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
