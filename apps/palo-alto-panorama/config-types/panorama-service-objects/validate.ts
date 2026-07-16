import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { PanoramaEntry, UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/Services'

export const SERVICE_PROTOCOLS = ['tcp', 'udp'] as const
export type ServiceProtocol = (typeof SERVICE_PROTOCOLS)[number]

/** PAN-OS port spec: single port, range (80-88) or comma list (80,443). */
const PORT_RE = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/

export interface ServiceSpec {
  sectionName: string
  name: string
  protocol: string
  port: string
  description: string
}

export interface LiveService extends PanoramaEntry {
  protocol?: { tcp?: { port?: string }; udp?: { port?: string } }
  description?: string
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractServiceSpecs(canvas: CanvasSnapshot): ServiceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      protocol: str(fields.protocol) || 'tcp',
      port: str(fields.port),
      description: str(fields.description),
    }
  })
}

/** Build the REST entry fields for a service object. */
export function buildServiceFields(spec: ServiceSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { protocol: { [spec.protocol]: { port: spec.port } } }
  if (spec.description) fields.description = spec.description
  return fields
}

export function serviceUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractServiceSpecs(canvas)
    .filter((s) => s.name && s.port && SERVICE_PROTOCOLS.includes(s.protocol as ServiceProtocol))
    .map((s) => ({ name: s.name, fields: buildServiceFields(s) }))
}

export function serviceDriftDiffs(spec: ServiceSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveService
  const livePort = str(live.protocol?.[spec.protocol as ServiceProtocol]?.port)
  if (livePort !== spec.port) {
    diffs.push({ field: `${spec.name}.${spec.protocol}.port`, expected: spec.port, actual: livePort || 'not set', severity: 'warning' })
  }
  if (spec.description && str(live.description) !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: str(live.description) || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate service objects: a name, a supported protocol and a valid port spec
 * are required, and the name is unique across the canvas.
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
  for (const spec of extractServiceSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Service name is required', code: 'required' })
    }
    if (!SERVICE_PROTOCOLS.includes(spec.protocol as ServiceProtocol)) {
      errors.push({ field: `${prefix}.protocol`, message: `Unsupported protocol "${spec.protocol}" — use tcp or udp`, code: 'invalid_protocol' })
    }
    if (!spec.port) {
      errors.push({ field: `${prefix}.port`, message: 'Port is required', code: 'required' })
    } else if (!PORT_RE.test(spec.port)) {
      errors.push({ field: `${prefix}.port`, message: `Invalid port spec "${spec.port}" — use 443, 80-88 or 80,443`, code: 'invalid_port' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate service "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
