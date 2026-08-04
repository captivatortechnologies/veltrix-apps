// Shared helpers for the Graylog Sidecar Collectors config type (validate +
// deploy + rollback + drift). Shapes follow the Graylog REST API
// (/api/sidecar/collectors):
//   • POST/PUT body  = Collector { name, service_type, node_operating_system,
//                       executable_path, execute_parameters?,
//                       validation_parameters?, default_template? }
//   • GET  response  = CollectorListResponse { total, collectors: [Collector] }
// A collector's true identity is the PAIR (name, node_operating_system) —
// Graylog allows the same collector name on different operating systems
// (CollectorResource.validate: `findByNameAndOs`) — so this config type
// reconciles by that pair even though the canvas only exposes `name` as the
// single identityField the platform supports.
// Source: org.graylog.plugins.sidecar.rest.resources.CollectorResource,
// org.graylog.plugins.sidecar.rest.models.Collector (@ 6.1).

import { asString } from '../../lib/coerce'

/** Operating systems Graylog Sidecar collectors can target. */
export const SIDECAR_OPERATING_SYSTEMS = new Set(['linux', 'windows', 'darwin', 'freebsd'])

/** Service types per OS (CollectorResource.VALID_*_SERVICE_TYPES — only Windows supports "svc"). */
export const SERVICE_TYPES_BY_OS: Record<string, Set<string>> = {
  linux: new Set(['exec']),
  windows: new Set(['exec', 'svc']),
  darwin: new Set(['exec']),
  freebsd: new Set(['exec']),
}

/** One collector as returned by GET /api/sidecar/collectors (Collector). */
export interface GraylogSidecarCollector {
  id?: string
  name?: string
  service_type?: string
  node_operating_system?: string
  executable_path?: string
  execute_parameters?: string
  validation_parameters?: string
  default_template?: string
  [key: string]: unknown
}

/** GET /api/sidecar/collectors envelope: `{ total, collectors: [...] }`. */
interface CollectorListResponse {
  total?: number
  collectors?: GraylogSidecarCollector[]
}

/** Body sent to POST /api/sidecar/collectors and PUT /api/sidecar/collectors/{id}. */
export interface SidecarCollectorBody {
  name: string
  service_type: string
  node_operating_system: string
  executable_path: string
  execute_parameters: string
  validation_parameters: string
  default_template: string
}

/** Unwrap GET /api/sidecar/collectors into a flat array of collectors. */
export function sidecarCollectorsFromList(list: unknown): GraylogSidecarCollector[] {
  if (Array.isArray(list)) return list as GraylogSidecarCollector[]
  const collectors = (list as CollectorListResponse | null)?.collectors
  return Array.isArray(collectors) ? collectors : []
}

/** Find a live collector by the (name, node_operating_system) pair — the true identity. */
export function findSidecarCollector(collectors: GraylogSidecarCollector[], name: string, os: string): GraylogSidecarCollector | null {
  const n = asString(name)
  const o = asString(os)
  if (!n || !o) return null
  return collectors.find((c) => asString(c.name) === n && asString(c.node_operating_system) === o) ?? null
}

/** Build the Collector body from canvas fields. */
export function buildSidecarCollectorBody(fields: Record<string, unknown>): SidecarCollectorBody {
  return {
    name: asString(fields.name),
    service_type: asString(fields.service_type) || 'exec',
    node_operating_system: asString(fields.node_operating_system).toLowerCase(),
    executable_path: asString(fields.executable_path),
    execute_parameters: asString(fields.execute_parameters),
    validation_parameters: asString(fields.validation_parameters),
    default_template: asString(fields.default_template),
  }
}

/** Build a restore body from a live collector (rollback). */
export function bodyFromLiveSidecarCollector(collector: GraylogSidecarCollector): SidecarCollectorBody {
  return {
    name: asString(collector.name),
    service_type: asString(collector.service_type) || 'exec',
    node_operating_system: asString(collector.node_operating_system).toLowerCase(),
    executable_path: asString(collector.executable_path),
    execute_parameters: asString(collector.execute_parameters),
    validation_parameters: asString(collector.validation_parameters),
    default_template: asString(collector.default_template),
  }
}
