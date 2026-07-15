import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Network Services constraints ----------------------------------------

/** ZIA caps a network service name at 255 characters. */
export const MAX_SERVICE_NAME_LENGTH = 255
/** ZIA allows a longer free-text description on a network service. */
export const MAX_SERVICE_DESCRIPTION_LENGTH = 10_240
/** Valid TCP/UDP port bounds. */
export const MIN_PORT = 1
export const MAX_PORT = 65_535

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

/** A single TCP/UDP port or an inclusive port range (end === start for one port). */
export interface PortRange {
  start: number
  end: number
}

export interface NetworkServiceSpec {
  sectionName: string
  /** The network service name — its logical identity (list + match). */
  name: string
  description?: string
  /** Parsed, valid TCP destination ports/ranges. */
  tcpPorts: PortRange[]
  /** Raw TCP port lines that did not parse — surfaced by validate. */
  tcpInvalid: string[]
  /** Parsed, valid UDP destination ports/ranges. */
  udpPorts: PortRange[]
  /** Raw UDP port lines that did not parse — surfaced by validate. */
  udpInvalid: string[]
}

/** Shape of a network service returned by GET /networkServices. */
export interface LiveNetworkService {
  id?: number
  name?: string
  description?: string
  /** "CUSTOM" for author-managed services; "PREDEFINED" for built-ins (read-only). */
  type?: string
  destTcpPorts?: PortRange[]
  destUdpPorts?: PortRange[]
  srcTcpPorts?: PortRange[]
  srcUdpPorts?: PortRange[]
}

/**
 * Parse one port line — "start" (single port) or "start-end" (inclusive range) —
 * into a PortRange, or null when it is not a valid port/range in 1–65535.
 */
export function parsePortLine(line: string): PortRange | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const dash = trimmed.indexOf('-')
  if (dash === -1) {
    const n = toPort(trimmed)
    return n === null ? null : { start: n, end: n }
  }
  const start = toPort(trimmed.slice(0, dash).trim())
  const end = toPort(trimmed.slice(dash + 1).trim())
  if (start === null || end === null || start > end) return null
  return { start, end }
}

/** Parse a single port token, rejecting non-digits and out-of-range values. */
function toPort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) return null
  return n
}

/** Split a textarea value into trimmed, non-blank port lines. */
function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Parse a textarea of port lines into valid ranges and the lines that failed. */
function extractPorts(value: unknown): { ports: PortRange[]; invalid: string[] } {
  const ports: PortRange[] = []
  const invalid: string[] = []
  for (const line of splitLines(value)) {
    const parsed = parsePortLine(line)
    if (parsed) ports.push(parsed)
    else invalid.push(line)
  }
  return { ports, invalid }
}

/** Each canvas item describes one ZIA network service. */
export function extractNetworkServiceSpecs(canvas: CanvasSnapshot): NetworkServiceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const tcp = extractPorts(fields.tcp_ports)
    const udp = extractPorts(fields.udp_ports)
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      tcpPorts: tcp.ports,
      tcpInvalid: tcp.invalid,
      udpPorts: udp.ports,
      udpInvalid: udp.invalid,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate network service configurations against ZIA constraints: a name is
 * required, capped at 255 chars, and unique across the canvas (case-insensitive,
 * since ZIA rejects services differing only in case). Every TCP/UDP port line
 * must parse to a valid port or range (1–65535), and at least one port must be
 * declared.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNetworkServiceSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Network service name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_SERVICE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Network service name must be ${MAX_SERVICE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate network service "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_network_service',
        })
      }
      seen.add(key)
    }

    if (spec.description && spec.description.length > MAX_SERVICE_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_SERVICE_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    for (const line of spec.tcpInvalid) {
      errors.push({
        field: `${prefix}.tcp_ports`,
        message: `Invalid TCP port "${line}" — use a port (e.g. "80") or range (e.g. "8000-8100") within 1–65535`,
        code: 'invalid_port',
      })
    }
    for (const line of spec.udpInvalid) {
      errors.push({
        field: `${prefix}.udp_ports`,
        message: `Invalid UDP port "${line}" — use a port (e.g. "53") or range (e.g. "5000-5100") within 1–65535`,
        code: 'invalid_port',
      })
    }

    const totalPortLines =
      spec.tcpPorts.length + spec.tcpInvalid.length + spec.udpPorts.length + spec.udpInvalid.length
    if (totalPortLines === 0) {
      errors.push({
        field: `${prefix}.tcp_ports`,
        message: 'At least one TCP or UDP port is required for a custom network service',
        code: 'ports_required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
