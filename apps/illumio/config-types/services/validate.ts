import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Illumio Core Service constraints -----------------------------------------
// name: 1-255 chars (Terraform `nameValidation`, "does not need to be unique").
// service_ports: proto is an IANA protocol number, -1 to 255 (-1 = "all
// services"). port/to_port only apply to proto 6 (TCP) or 17 (UDP); icmp_type/
// icmp_code only apply to proto 1 (ICMP) or 58 (ICMPv6); to_port requires port;
// icmp_code requires icmp_type. Confirmed against the Terraform provider's
// service resource (isPortServiceSchemaValid):
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_service.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/service.go

export const MAX_NAME_LENGTH = 255
const TCP = 6
const UDP = 17
const ICMP = 1
const ICMPV6 = 58

export interface ServicePortSpec {
  proto: number
  port?: number
  toPort?: number
  icmpType?: number
  icmpCode?: number
}

export interface ServiceSpec {
  itemId?: string
  name: string
  description: string
  servicePorts: ServicePortSpec[]
  externalDataSet: string
  externalDataReference: string
  /** Set when servicePortsJson failed to parse — the raw parse error, surfaced by validate. */
  servicePortsError?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asOptionalInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

/** Parse the service_ports JSON-array textarea field. Blank -> empty array, no error. */
function parseServicePortsJson(raw: unknown): { value: Record<string, unknown>[]; error?: string } {
  const s = asString(raw)
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  return { value: parsed.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object') }
}

export function extractServiceSpecs(canvas: CanvasSnapshot): ServiceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const parsed = parseServicePortsJson(f.servicePortsJson)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      servicePorts: parsed.value.map((p) => ({
        proto: asOptionalInt(p.proto) ?? NaN,
        port: asOptionalInt(p.port),
        toPort: asOptionalInt(p.toPort),
        icmpType: asOptionalInt(p.icmpType),
        icmpCode: asOptionalInt(p.icmpCode),
      })),
      externalDataSet: asString(f.externalDataSet),
      externalDataReference: asString(f.externalDataReference),
      servicePortsError: parsed.error,
    }
  })
}

/** Validate one service_ports entry against the PCE's proto-dependent field rules. */
export function validateServicePort(p: ServicePortSpec): string | null {
  if (!Number.isInteger(p.proto) || p.proto < -1 || p.proto > 255) {
    return 'proto must be an integer between -1 and 255'
  }
  const hasPort = p.port !== undefined
  const hasToPort = p.toPort !== undefined
  const hasIcmpType = p.icmpType !== undefined
  const hasIcmpCode = p.icmpCode !== undefined

  if (p.proto === TCP || p.proto === UDP) {
    if (hasIcmpType || hasIcmpCode) return 'icmpType/icmpCode are not allowed when proto is TCP (6) or UDP (17)'
    if (!hasPort && hasToPort) return 'toPort requires port to also be set'
    if (hasToPort && p.port !== undefined && p.toPort! <= p.port) return 'toPort must be greater than port'
  } else if (p.proto === ICMP || p.proto === ICMPV6) {
    if (hasPort || hasToPort) return 'port/toPort are not allowed when proto is ICMP (1) or ICMPv6 (58)'
    if (hasIcmpCode && !hasIcmpType) return 'icmpCode requires icmpType to also be set'
  } else {
    if (hasPort || hasToPort) return 'port/toPort are only allowed when proto is TCP (6) or UDP (17)'
    if (hasIcmpType || hasIcmpCode) return 'icmpType/icmpCode are only allowed when proto is ICMP (1) or ICMPv6 (58)'
  }
  return null
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate service "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.servicePortsError) {
      errors.push({ field: `${prefix}.servicePortsJson`, message: `Service ports ${spec.servicePortsError}`, code: 'invalid_json' })
      return
    }

    if (spec.servicePorts.length === 0) {
      errors.push({ field: `${prefix}.servicePortsJson`, message: 'A service needs at least one service port entry', code: 'empty_ports' })
    }

    spec.servicePorts.forEach((p, pi) => {
      const err = validateServicePort(p)
      if (err) {
        errors.push({ field: `${prefix}.servicePortsJson[${pi}]`, message: err, code: 'invalid_port' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
