import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Illumio Core Virtual Service constraints ---------------------------------
// name: 1-255 chars (Terraform `nameValidation`). apply_to: required, one of
// "host_only" | "internal_bridge_network". service vs service_ports:
// ExactlyOneOf — confirmed against the Terraform schema
// (`ExactlyOneOf: []string{"service", "service_ports"}`). service_ports.proto
// is restricted to 6 (TCP) or 17 (UDP) here — narrower than the Services
// config type's proto range, per the Terraform schema's own
// `StringInSlice([]string{"6", "17"}, true)` on virtual_service service_ports
// (unlike services' broader ICMP-inclusive range). Confirmed against:
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_virtual_service.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/virtual_service.go

export const MAX_NAME_LENGTH = 255
export const APPLY_TO_VALUES = ['host_only', 'internal_bridge_network'] as const
const TCP = 6
const UDP = 17

export interface ServicePortSpec {
  proto: number
  port?: number
  toPort?: number
}

export interface LabelRef {
  key: string
  value: string
}

export interface VirtualServiceSpec {
  itemId?: string
  name: string
  description: string
  applyTo: string
  /** Name of an existing Service (mutually exclusive with servicePorts). */
  serviceName: string
  servicePorts: ServicePortSpec[]
  labels: LabelRef[]
  ipOverrides: string[]
  externalDataSet: string
  externalDataReference: string
  servicePortsError?: string
  labelsError?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asOptionalInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) ? n : undefined
}

function parseJsonArray(raw: unknown): { value: Record<string, unknown>[]; error?: string } {
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

function parseLabelRefArray(raw: unknown): { value: LabelRef[]; error?: string } {
  const parsed = parseJsonArray(raw)
  if (parsed.error) return { value: [], error: parsed.error }
  return { value: parsed.value.map((e) => ({ key: asString(e.key), value: asString(e.value) })) }
}

export function extractVirtualServiceSpecs(canvas: CanvasSnapshot): VirtualServiceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const portsParsed = parseJsonArray(f.servicePortsJson)
    const labelsParsed = parseLabelRefArray(f.labelsJson)
    const ipOverrides = Array.isArray(f.ipOverrides)
      ? f.ipOverrides.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      : []
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      applyTo: asString(f.applyTo),
      serviceName: asString(f.serviceName),
      servicePorts: portsParsed.value.map((p) => ({
        proto: asOptionalInt(p.proto) ?? NaN,
        port: asOptionalInt(p.port),
        toPort: asOptionalInt(p.toPort),
      })),
      labels: labelsParsed.value,
      ipOverrides,
      externalDataSet: asString(f.externalDataSet),
      externalDataReference: asString(f.externalDataReference),
      servicePortsError: portsParsed.error,
      labelsError: labelsParsed.error,
    }
  })
}

export function validateServicePort(p: ServicePortSpec): string | null {
  if (p.proto !== TCP && p.proto !== UDP) return 'proto must be 6 (TCP) or 17 (UDP)'
  if (p.toPort !== undefined && p.port === undefined) return 'toPort requires port to also be set'
  if (p.toPort !== undefined && p.port !== undefined && p.toPort <= p.port) return 'toPort must be greater than port'
  return null
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractVirtualServiceSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate virtual service "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(APPLY_TO_VALUES as readonly string[]).includes(spec.applyTo)) {
      errors.push({ field: `${prefix}.applyTo`, message: `Apply To must be one of: ${APPLY_TO_VALUES.join(', ')}`, code: 'invalid_apply_to' })
    }

    if (spec.servicePortsError) {
      errors.push({ field: `${prefix}.servicePortsJson`, message: `Service ports ${spec.servicePortsError}`, code: 'invalid_json' })
    } else {
      const hasService = !!spec.serviceName
      const hasPorts = spec.servicePorts.length > 0
      if (hasService === hasPorts) {
        errors.push({
          field: `${prefix}.serviceName`,
          message: 'Set exactly one of Service name or Service ports',
          code: 'exactly_one_service',
        })
      }
      spec.servicePorts.forEach((p, pi) => {
        const err = validateServicePort(p)
        if (err) errors.push({ field: `${prefix}.servicePortsJson[${pi}]`, message: err, code: 'invalid_port' })
      })
    }

    if (spec.labelsError) {
      errors.push({ field: `${prefix}.labelsJson`, message: `Labels ${spec.labelsError}`, code: 'invalid_json' })
    } else {
      spec.labels.forEach((l, li) => {
        if (!l.key || !l.value) {
          errors.push({ field: `${prefix}.labelsJson[${li}]`, message: 'Each label ref needs both key and value', code: 'invalid_label_ref' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
