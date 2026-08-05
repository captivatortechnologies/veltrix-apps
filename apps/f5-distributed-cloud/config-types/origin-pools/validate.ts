import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { F5xcRef } from '../../lib/f5xc'

// --- F5 XC Origin Pool API constraints -----------------------------------------
// https://docs.cloud.f5.com/docs-v2/api/views-origin-pool
//
// GET/POST       /config/namespaces/{namespace}/origin_pools         - list / create
// GET/PUT/DELETE /config/namespaces/{namespace}/origin_pools/{name}  - read / update / delete
//
// endpoint_selection / loadbalancer_algorithm enums confirmed against
// pbgo/extschema/schema/cluster/types.pb.go (EndpointSelectionPolicy_name,
// LoadbalancerAlgorithm_name).

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const MAX_NAME_LENGTH = 63

export type EndpointSelection = 'DISTRIBUTED' | 'LOCAL_ONLY' | 'LOCAL_PREFERRED'
export type LoadbalancerAlgorithm = 'ROUND_ROBIN' | 'LEAST_REQUEST' | 'RING_HASH' | 'RANDOM' | 'LB_OVERRIDE'
export type PortMode = 'automatic_port' | 'lb_port' | 'port'
export type TlsMode = 'no_tls' | 'use_tls'
export type TlsServerVerification = 'volterra_trusted_ca' | 'skip_server_verification'

const ENDPOINT_SELECTIONS: EndpointSelection[] = ['DISTRIBUTED', 'LOCAL_ONLY', 'LOCAL_PREFERRED']
const LB_ALGORITHMS: LoadbalancerAlgorithm[] = ['ROUND_ROBIN', 'LEAST_REQUEST', 'RING_HASH', 'RANDOM', 'LB_OVERRIDE']

export interface OriginPoolSpec {
  sectionName: string
  name: string
  description?: string
  disable: boolean
  endpointSelection: EndpointSelection
  loadbalancerAlgorithm: LoadbalancerAlgorithm
  healthChecks: string[]
  portMode: PortMode
  port?: number
  tlsMode: TlsMode
  tlsServerVerification: TlsServerVerification
  originServersJson: string
}

/** Shape of an origin_pool spec returned by GET .../origin_pools/{name}. */
export interface LiveOriginPoolSpec {
  endpoint_selection?: string
  loadbalancer_algorithm?: string
  healthcheck?: F5xcRef[]
  automatic_port?: boolean
  lb_port?: boolean
  port?: number
  no_tls?: boolean
  use_tls?: Record<string, unknown>
  origin_servers?: Array<Record<string, unknown>>
  [key: string]: unknown
}

function toText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Each canvas item describes one F5 XC origin pool. */
export function extractOriginPoolSpecs(canvas: CanvasSnapshot): OriginPoolSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const endpointSelection: EndpointSelection = (ENDPOINT_SELECTIONS as string[]).includes(
      fields.endpointSelection as string,
    )
      ? (fields.endpointSelection as EndpointSelection)
      : 'LOCAL_PREFERRED'
    const loadbalancerAlgorithm: LoadbalancerAlgorithm = (LB_ALGORITHMS as string[]).includes(
      fields.loadbalancerAlgorithm as string,
    )
      ? (fields.loadbalancerAlgorithm as LoadbalancerAlgorithm)
      : 'ROUND_ROBIN'
    const portMode: PortMode =
      fields.portMode === 'automatic_port' || fields.portMode === 'lb_port' ? fields.portMode : 'port'
    const tlsMode: TlsMode = fields.tlsMode === 'use_tls' ? 'use_tls' : 'no_tls'
    const tlsServerVerification: TlsServerVerification =
      fields.tlsServerVerification === 'skip_server_verification' ? 'skip_server_verification' : 'volterra_trusted_ca'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: toText(fields.description),
      disable: fields.disable === true,
      endpointSelection,
      loadbalancerAlgorithm,
      healthChecks: Array.isArray(fields.healthChecks)
        ? fields.healthChecks.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        : [],
      portMode,
      port: toNumber(fields.port),
      tlsMode,
      tlsServerVerification,
      originServersJson: typeof fields.originServersJson === 'string' ? fields.originServersJson : '',
    }
  })
}

/** Parse originServersJson; returns null (not throws) on invalid JSON or shape. */
export function parseOriginServers(json: string): Array<Record<string, unknown>> | null {
  if (!json.trim()) return null
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (!parsed.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) return null
    return parsed as Array<Record<string, unknown>>
  } catch {
    return null
  }
}

/**
 * Validate origin pool configurations against the F5 XC API. Static only:
 *   - name is required, DNS-1035, <= 63 chars, and unique within the canvas
 *   - endpointSelection/loadbalancerAlgorithm must be known enum values
 *   - port is required when portMode is "port"
 *   - originServersJson must parse to a non-empty JSON array of objects
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractOriginPoolSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Origin pool name is required', code: 'required' })
      continue
    }
    if (!NAME_PATTERN.test(spec.name) || spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Name must be a DNS-1035 label: lowercase alphanumeric and hyphens, starting with a letter, 63 characters or fewer',
        code: 'invalid_name',
      })
    }
    const key = spec.name.toLowerCase()
    if (seenNames.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate origin pool "${spec.name}" - each pool may only be declared once per canvas`,
        code: 'duplicate_name',
      })
    }
    seenNames.add(key)

    if (spec.portMode === 'port' && (spec.port === undefined || spec.port < 1 || spec.port > 65535)) {
      errors.push({
        field: `${prefix}.port`,
        message: 'Port Number (1-65535) is required when Port is set to Fixed Port',
        code: 'required',
      })
    }

    const originServers = parseOriginServers(spec.originServersJson)
    if (!originServers) {
      errors.push({
        field: `${prefix}.originServersJson`,
        message: 'Origin Servers must be a non-empty JSON array of origin server objects',
        code: 'invalid_json',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
