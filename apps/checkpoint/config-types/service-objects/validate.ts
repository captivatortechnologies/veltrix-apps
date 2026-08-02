import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { objectKey, strList } from '../lib/checkpointShared'

// --- Shared types --------------------------------------------------------------

export const PROTOCOLS = ['tcp', 'udp'] as const
export type ServiceProtocol = (typeof PROTOCOLS)[number]

/** Per-protocol Management API command names (verified against the official
 *  CheckPointAnsibleMgmtCollection cp_mgmt_service_tcp[_facts]/service_udp[_facts]
 *  modules — api_call_object_plural_version = "services-tcp" / "services-udp"). */
export const SERVICE_COMMANDS: Record<ServiceProtocol, { add: string; set: string; delete: string; showAll: string }> = {
  tcp: { add: 'add-service-tcp', set: 'set-service-tcp', delete: 'delete-service-tcp', showAll: 'show-services-tcp' },
  udp: { add: 'add-service-udp', set: 'set-service-udp', delete: 'delete-service-udp', showAll: 'show-services-udp' },
}

export interface ServiceSpec {
  itemId?: string
  /** name — the identity Check Point service objects are matched on. */
  name: string
  protocol: ServiceProtocol
  port: string
  sourcePort: string
  comments: string
  color: string
  tags: string[]
}

/** A service object as returned by show-service-tcp(s) / show-service-udp(s). */
export interface LiveService {
  uid?: string
  name?: string
  port?: string | number
  'source-port'?: string | number
  comments?: string
  color?: string
  tags?: Array<string | { name?: string }>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const serviceKey = objectKey

export function extractServiceSpecs(canvas: CanvasSnapshot): ServiceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const rawProtocol = asString(f.protocol).toLowerCase()
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      protocol: (PROTOCOLS as readonly string[]).includes(rawProtocol) ? (rawProtocol as ServiceProtocol) : 'tcp',
      port: asString(f.port),
      sourcePort: asString(f.sourcePort),
      comments: asString(f.comments),
      color: asString(f.color),
      tags: strList(f.tags),
    }
  })
}

// --- Port validation ---------------------------------------------------------

// A single port (1-65535), a range ("8000-8010"), or a comma list of either
// ("80,443,8080-8090") — the format Check Point's own `port` field accepts.
const PORT_TOKEN_RE = /^\d{1,5}(-\d{1,5})?$/

function isValidPortNumber(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export function isValidPortSpec(value: string): boolean {
  if (!value) return false
  const tokens = value.split(',').map((t) => t.trim())
  return tokens.every((token) => {
    if (!PORT_TOKEN_RE.test(token)) return false
    const [a, b] = token.split('-').map(Number)
    if (!isValidPortNumber(a)) return false
    if (b !== undefined && (!isValidPortNumber(b) || b < a)) return false
    return true
  })
}

// --- Validate handler -----------------------------------------------------------

/**
 * Validate Check Point service-object configurations: a name is required and
 * unique across the canvas (case-insensitive); protocol must be tcp or udp;
 * port is required and must be a valid port/range/list; an optional source
 * port, if set, must also be valid.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServiceSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = serviceKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate service "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!(PROTOCOLS as readonly string[]).includes(spec.protocol)) {
      errors.push({ field: `${prefix}.protocol`, message: 'Protocol must be tcp or udp', code: 'invalid_protocol' })
    }

    if (!spec.port) {
      errors.push({ field: `${prefix}.port`, message: 'Port is required', code: 'required' })
    } else if (!isValidPortSpec(spec.port)) {
      errors.push({
        field: `${prefix}.port`,
        message: `"${spec.port}" is not a valid port, range (e.g. 8000-8010) or comma list`,
        code: 'invalid_port',
      })
    }

    if (spec.sourcePort && !isValidPortSpec(spec.sourcePort)) {
      errors.push({
        field: `${prefix}.sourcePort`,
        message: `"${spec.sourcePort}" is not a valid port, range or comma list`,
        code: 'invalid_port',
      })
    }

    if (spec.tags.some((t) => t.length === 0)) {
      errors.push({ field: `${prefix}.tags`, message: 'Tags must not contain empty values', code: 'invalid_tag' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
