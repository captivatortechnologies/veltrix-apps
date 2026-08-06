import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { FmcObject } from '../../lib/fmc'

// Verified against CiscoDevNet/terraform-provider-fmc's
// gen/definitions/{host,network,range,fqdn}.yaml `rest_endpoint`.
export const HOSTS_PATH = '/object/hosts'
export const NETWORKS_PATH = '/object/networks'
export const RANGES_PATH = '/object/ranges'
export const FQDNS_PATH = '/object/fqdns'

export const NETWORK_OBJECT_KINDS = ['host', 'network', 'range', 'fqdn'] as const
export type NetworkObjectKind = (typeof NETWORK_OBJECT_KINDS)[number]

export const DNS_RESOLUTIONS = ['IPV4_ONLY', 'IPV6_ONLY', 'IPV4_AND_IPV6'] as const

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

export function pathForKind(kind: string): string {
  switch (kind) {
    case 'host':
      return HOSTS_PATH
    case 'network':
      return NETWORKS_PATH
    case 'range':
      return RANGES_PATH
    case 'fqdn':
      return FQDNS_PATH
    default:
      return HOSTS_PATH
  }
}

export interface NetworkObjectSpec {
  sectionName: string
  name: string
  kind: string
  value: string
  dnsResolution: string
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

export function extractNetworkObjectSpecs(canvas: CanvasSnapshot): NetworkObjectSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      kind: str(fields.kind) || 'host',
      value: str(fields.value),
      dnsResolution: str(fields.dns_resolution) || 'IPV4_AND_IPV6',
      description: str(fields.description),
      overridable: coerceBool(fields.overridable, false),
    }
  })
}

/** Build the FMC body fields (everything except name/id, which the caller adds). */
export function buildNetworkObjectFields(spec: NetworkObjectSpec): Record<string, unknown> {
  const fields: Record<string, unknown> = { value: spec.value, overridable: spec.overridable }
  if (spec.kind === 'fqdn') fields.dnsResolution = spec.dnsResolution
  if (spec.description) fields.description = spec.description
  return fields
}

export function networkObjectDriftDiffs(spec: NetworkObjectSpec, live: FmcObject): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const liveValue = typeof live.value === 'string' ? live.value : ''
  if (liveValue !== spec.value) {
    diffs.push({ field: `${spec.name}.value`, expected: spec.value, actual: liveValue || 'not set', severity: 'warning' })
  }
  if (spec.kind === 'fqdn') {
    const liveDns = typeof live.dnsResolution === 'string' ? live.dnsResolution : ''
    if (liveDns && liveDns !== spec.dnsResolution) {
      diffs.push({ field: `${spec.name}.dns_resolution`, expected: spec.dnsResolution, actual: liveDns, severity: 'info' })
    }
  }
  const liveDescription = typeof live.description === 'string' ? live.description : ''
  if (spec.description && liveDescription !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDescription || 'not set', severity: 'info' })
  }
  return diffs
}

/**
 * Validate network objects: a valid name, a supported kind, and a value are
 * required (light format sanity per kind - FMC is the source of truth for
 * full validity), and names are unique across the canvas.
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
  for (const spec of extractNetworkObjectSpecs(ctx.canvas)) {
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

    if (!NETWORK_OBJECT_KINDS.includes(spec.kind as NetworkObjectKind)) {
      errors.push({ field: `${prefix}.kind`, message: `Unsupported kind "${spec.kind}"`, code: 'invalid_kind' })
    }

    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Value is required', code: 'required' })
    } else if (spec.kind === 'range' && !spec.value.includes('-')) {
      errors.push({ field: `${prefix}.value`, message: 'A range value must be "start-end"', code: 'invalid_value' })
    } else if (spec.kind === 'network' && !spec.value.includes('/')) {
      errors.push({ field: `${prefix}.value`, message: 'A network value must be a CIDR prefix, e.g. 10.0.0.0/24', code: 'invalid_value' })
    }

    if (spec.kind === 'fqdn' && !DNS_RESOLUTIONS.includes(spec.dnsResolution as (typeof DNS_RESOLUTIONS)[number])) {
      errors.push({ field: `${prefix}.dns_resolution`, message: `Unsupported DNS resolution "${spec.dnsResolution}"`, code: 'invalid_dns_resolution' })
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
