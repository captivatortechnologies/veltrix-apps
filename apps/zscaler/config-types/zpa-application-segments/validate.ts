import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZPA Application Segment constraints --------------------------------------

/** ZPA caps an application segment name at 255 characters. */
export const MAX_SEGMENT_NAME_LENGTH = 255

/** Traffic bypass behaviour for the segment. */
export const BYPASS_TYPES = ['NEVER', 'ALWAYS', 'ON_NET'] as const
export const DEFAULT_BYPASS_TYPE = 'NEVER'

/** Health reporting cadence for the segment's server groups. */
export const HEALTH_REPORTING_TYPES = ['NONE', 'ON_ACCESS', 'CONTINUOUS'] as const
export const DEFAULT_HEALTH_REPORTING = 'ON_ACCESS'

/** Lowest / highest legal TCP/UDP port number. */
export const MIN_PORT = 1
export const MAX_PORT = 65535

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

/** A single TCP/UDP port range, sent to ZPA as string `from`/`to` bounds. */
export interface PortRange {
  from: string
  to: string
}

export interface ApplicationSegmentSpec {
  sectionName: string
  /** The application segment name — its logical identity (list + match). */
  name: string
  description?: string
  enabled: boolean
  /** FQDNs / wildcards the segment answers for, one per authored line. */
  domainNames: string[]
  /** Name of the segment group this segment belongs to (resolved to an id). */
  segmentGroupName: string
  /** Names of the server groups backing the segment (resolved to ids). */
  serverGroupNames: string[]
  /** Raw TCP port-range lines ("start-end" or "port"), parsed on demand. */
  tcpPortRanges: string[]
  /** Raw UDP port-range lines ("start-end" or "port"), parsed on demand. */
  udpPortRanges: string[]
  bypassType: string
  healthReporting: string
}

/** Shape of an application segment returned by GET /application. */
export interface LiveApplicationSegment {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  domainNames?: string[]
  segmentGroupId?: string
  segmentGroupName?: string
  serverGroups?: Array<{ id?: string; name?: string }>
  tcpPortRange?: Array<{ from?: string; to?: string }>
  udpPortRange?: Array<{ from?: string; to?: string }>
  bypassType?: string
  healthReporting?: string
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Read a text field as a trimmed string (numbers are stringified). */
export function readText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Read an optional text field — undefined when blank. */
function optionalText(value: unknown): string | undefined {
  const text = readText(value)
  return text ? text : undefined
}

/** Split a textarea value into trimmed, non-blank lines. */
export function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Read a select field, falling back to `fallback` for values outside `allowed`. */
function readSelect(value: unknown, allowed: readonly string[], fallback: string): string {
  const text = readText(value).toUpperCase()
  return allowed.includes(text) ? text : fallback
}

/**
 * Parse a port-range line ("start-end" or a single "port") into a `{from,to}`
 * pair (a single port yields `from === to`). Returns null when the line is not a
 * pair/single of integers each within 1–65535 with `from <= to`.
 */
export function parsePortRange(line: string): PortRange | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  const parts = trimmed.split('-').map((part) => part.trim())
  let fromStr: string
  let toStr: string
  if (parts.length === 1) {
    fromStr = parts[0]
    toStr = parts[0]
  } else if (parts.length === 2) {
    fromStr = parts[0]
    toStr = parts[1]
  } else {
    return null
  }

  // Number('') is 0 and Number('8x') is NaN — the integer + range checks reject both.
  const from = Number(fromStr)
  const to = Number(toStr)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < MIN_PORT || from > MAX_PORT || to < MIN_PORT || to > MAX_PORT) return null
  if (from > to) return null

  return { from: String(from), to: String(to) }
}

/** Parse a list of port-range lines, dropping any that fail to parse. */
export function parsePortRanges(lines: string[]): PortRange[] {
  const ranges: PortRange[] = []
  for (const line of lines) {
    const parsed = parsePortRange(line)
    if (parsed) ranges.push(parsed)
  }
  return ranges
}

/** Each canvas item describes one ZPA application segment. */
export function extractApplicationSegmentSpecs(canvas: CanvasSnapshot): ApplicationSegmentSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readText(fields.name),
      description: optionalText(fields.description),
      enabled: readBool(fields.enabled, true),
      domainNames: splitLines(fields.domain_names),
      segmentGroupName: readText(fields.segment_group_name),
      serverGroupNames: splitLines(fields.server_group_names),
      tcpPortRanges: splitLines(fields.tcp_port_ranges),
      udpPortRanges: splitLines(fields.udp_port_ranges),
      bypassType: readSelect(fields.bypass_type, BYPASS_TYPES, DEFAULT_BYPASS_TYPE),
      healthReporting: readSelect(fields.health_reporting, HEALTH_REPORTING_TYPES, DEFAULT_HEALTH_REPORTING),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate application segment configurations against ZPA constraints. A name is
 * required, capped at 255 chars and unique across the canvas (matched
 * case-insensitively — ZPA rejects segments differing only in case). Every
 * segment needs at least one domain name, a segment group, at least one server
 * group and at least one TCP or UDP port range; each authored port-range line
 * must parse to a valid 1–65535 range.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractApplicationSegmentSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Application segment name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_SEGMENT_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Application segment name must be ${MAX_SEGMENT_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate application segment "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_application_segment',
        })
      }
      seen.add(key)
    }

    if (spec.domainNames.length === 0) {
      errors.push({
        field: `${prefix}.domain_names`,
        message: 'At least one domain name (FQDN or wildcard) is required',
        code: 'required',
      })
    }

    if (!spec.segmentGroupName) {
      errors.push({
        field: `${prefix}.segment_group_name`,
        message: 'A segment group name is required',
        code: 'required',
      })
    }

    if (spec.serverGroupNames.length === 0) {
      errors.push({
        field: `${prefix}.server_group_names`,
        message: 'At least one server group name is required',
        code: 'required',
      })
    }

    if (spec.tcpPortRanges.length === 0 && spec.udpPortRanges.length === 0) {
      errors.push({
        field: `${prefix}.tcp_port_ranges`,
        message: 'At least one TCP or UDP port range is required',
        code: 'required',
      })
    }

    for (const line of spec.tcpPortRanges) {
      if (!parsePortRange(line)) {
        errors.push({
          field: `${prefix}.tcp_port_ranges`,
          message: `Invalid TCP port range "${line}" — use "start-end" or a single port (${MIN_PORT}-${MAX_PORT})`,
          code: 'invalid_port_range',
        })
      }
    }
    for (const line of spec.udpPortRanges) {
      if (!parsePortRange(line)) {
        errors.push({
          field: `${prefix}.udp_port_ranges`,
          message: `Invalid UDP port range "${line}" — use "start-end" or a single port (${MIN_PORT}-${MAX_PORT})`,
          code: 'invalid_port_range',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
