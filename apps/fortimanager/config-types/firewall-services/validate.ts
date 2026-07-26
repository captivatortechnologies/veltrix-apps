import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager custom firewall service constraints ------------------------

export const MAX_NAME_LENGTH = 79
export const PROTOCOLS = ['TCP/UDP/SCTP', 'ICMP', 'ICMP6', 'IP'] as const
/** dstlow[-dsthigh][:srclow[-srchigh]] */
const PORT_RANGE_RE = /^\d{1,5}(-\d{1,5})?(:\d{1,5}(-\d{1,5})?)?$/

export interface ServiceSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** TCP/UDP/SCTP | ICMP | ICMP6 | IP. */
  protocol: string
  tcpPortrange: string[]
  udpPortrange: string[]
  sctpPortrange: string[]
  /** protocol-number for IP services (0–254). */
  protocolNumber: string
  icmptype: string
  icmpcode: string
  comment: string
}

/** A custom service as returned by a get on the service/custom table. */
export interface LiveService {
  name?: string
  protocol?: string | number
  'tcp-portrange'?: string[] | string
  'udp-portrange'?: string[] | string
  'sctp-portrange'?: string[] | string
  'protocol-number'?: number
  icmptype?: number
  icmpcode?: number
  comment?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a port-range value into tokens (by whitespace or comma). */
export function splitPorts(v: unknown): string[] {
  return asString(v).split(/[\s,]+/).map((t) => t.trim()).filter((t) => t.length > 0)
}

export function extractServiceSpecs(canvas: CanvasSnapshot): ServiceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      protocol: asString(f.protocol) || 'TCP/UDP/SCTP',
      tcpPortrange: splitPorts(f.tcpPortrange),
      udpPortrange: splitPorts(f.udpPortrange),
      sctpPortrange: splitPorts(f.sctpPortrange),
      protocolNumber: asString(f.protocolNumber),
      icmptype: asString(f.icmptype),
      icmpcode: asString(f.icmpcode),
      comment: asString(f.comment),
    }
  })
}

function validPorts(tokens: string[], prefix: string, field: string, errors: ValidationResult['errors']): void {
  tokens.forEach((t, i) => {
    if (!PORT_RANGE_RE.test(t)) {
      errors.push({ field: `${prefix}.${field}[${i}]`, message: `"${t}" is not a valid port range (e.g. 443, 100-200, 100-200:1024-65535)`, code: 'invalid_port_range' })
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractServiceSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate service "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(PROTOCOLS as readonly string[]).includes(spec.protocol)) {
      errors.push({ field: `${prefix}.protocol`, message: `Protocol must be one of: ${PROTOCOLS.join(', ')}`, code: 'invalid_protocol' })
      return
    }

    if (spec.protocol === 'TCP/UDP/SCTP') {
      if (spec.tcpPortrange.length === 0 && spec.udpPortrange.length === 0 && spec.sctpPortrange.length === 0) {
        errors.push({ field: `${prefix}.tcpPortrange`, message: 'A TCP/UDP/SCTP service needs at least one TCP, UDP or SCTP port range', code: 'missing_ports' })
      }
      validPorts(spec.tcpPortrange, prefix, 'tcpPortrange', errors)
      validPorts(spec.udpPortrange, prefix, 'udpPortrange', errors)
      validPorts(spec.sctpPortrange, prefix, 'sctpPortrange', errors)
    } else if (spec.protocol === 'IP') {
      const n = Number(spec.protocolNumber)
      if (!spec.protocolNumber || !Number.isInteger(n) || n < 0 || n > 254) {
        errors.push({ field: `${prefix}.protocolNumber`, message: 'An IP service needs a protocol number (0–254)', code: 'invalid_protocol_number' })
      }
    } else {
      // ICMP / ICMP6 — type/code optional but numeric when present
      if (spec.icmptype && !/^\d+$/.test(spec.icmptype)) {
        errors.push({ field: `${prefix}.icmptype`, message: 'ICMP type must be numeric', code: 'invalid_icmp' })
      }
      if (spec.icmpcode && !/^\d+$/.test(spec.icmpcode)) {
        errors.push({ field: `${prefix}.icmpcode`, message: 'ICMP code must be numeric', code: 'invalid_icmp' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
