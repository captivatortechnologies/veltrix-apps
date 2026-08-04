// Shared helpers for the Imperva Cloud WAF Data Centers config type (deploy +
// rollback + drift). A Data Center is a named pool of one or more ORIGIN
// SERVERS for a site — the backend(s) Imperva proxies traffic to. Managed over
// the legacy Cloud WAF (Incapsula) management API v1:
//   pool:    POST /sites/dataCenters/{add,edit,delete,list}
//   servers: POST /sites/dataCenters/servers/{add,edit,delete}
//
// `add` creates the pool TOGETHER with its first server (the API takes a single
// `server_address` at creation); additional servers are added one at a time
// afterwards. This config type therefore reconciles two levels per item: the
// data center itself (by NAME within a site) and its servers (by ADDRESS within
// the data center) — list current servers, add missing addresses, edit changed
// ones, delete addresses no longer declared.
//
// FLAG (provenance / deprecation): Imperva's official Terraform provider marks
// the v1-based `incapsula_data_center` / `incapsula_data_center_server`
// resources DEPRECATED in favor of a newer v3 resource
// (`incapsula_data_centers_configuration`, a different, non-legacy API this app
// deliberately stays out of — see lib/impervaApi.ts). The v1 endpoints above
// remain live and documented in the provider's client code
// (incapsula/client_data_center.go, client_data_center_server.go) as of this
// writing; verify against a live Imperva account that they have not since been
// sunset.

import { type ImpervaEnvelope } from '../../lib/impervaApi'

/** One origin server as returned inside a data center's `servers[]` (list). */
export interface DataCenterServerStatus {
  id?: string
  address?: string
  enabled?: string | boolean
  isStandBy?: string | boolean
  [key: string]: unknown
}

/** One data center (origin server pool) as returned by `sites/dataCenters/list`. */
export interface DataCenterStatus {
  id?: string
  name?: string
  enabled?: string | boolean
  contentOnly?: string | boolean
  isActive?: string | boolean
  originPop?: string
  servers?: DataCenterServerStatus[]
  [key: string]: unknown
}

/** Extract the data center list from a `sites/dataCenters/list` envelope. */
export function dataCentersFromResponse(payload: ImpervaEnvelope | null): DataCenterStatus[] {
  if (!payload || typeof payload !== 'object') return []
  const dcs = (payload as Record<string, unknown>).DCs
  return Array.isArray(dcs) ? (dcs as DataCenterStatus[]) : []
}

/** Find a data center by (case-insensitive) name — the identity within a site. */
export function findDataCenter(dcs: DataCenterStatus[], name: string): DataCenterStatus | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return dcs.find((dc) => String(dc.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Find a server by (case-insensitive) address — the identity within a data center. */
export function findServer(servers: DataCenterServerStatus[], address: string): DataCenterServerStatus | null {
  const a = address.trim().toLowerCase()
  if (!a) return null
  return servers.find((s) => String(s.address ?? '').trim().toLowerCase() === a) ?? null
}

/** `enabled`/`isStandBy` arrive from Imperva as 'true'/'false' strings or booleans — normalize. */
export function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return fallback
}

export interface ServerFields {
  address: string
  isStandby: boolean
  isEnabled: boolean
}

export interface DataCenterFields {
  siteId: string
  name: string
  isContentOnly: boolean
  isEnabled: boolean
  servers: ServerFields[]
}

/**
 * Parse the `servers` JSON textarea into a normalized server list, KEEPING every
 * entry (including one with a blank address) so validate.ts can flag a specific
 * missing address by index rather than have it silently vanish. Malformed /
 * missing JSON → [].
 */
export function parseServersRaw(raw: unknown): ServerFields[] {
  let value: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    try {
      value = JSON.parse(trimmed)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>
    return {
      address: String(e.address ?? '').trim(),
      isStandby: toBool(e.isStandby, false),
      isEnabled: toBool(e.isEnabled, true),
    }
  })
}

/** Same as parseServersRaw, but drops entries with no address — used by deploy/drift. */
export function parseServers(raw: unknown): ServerFields[] {
  return parseServersRaw(raw).filter((s) => s.address.length > 0)
}

/** Read + normalize the canvas fields for one data center item. */
export function readDataCenterFields(fields: Record<string, unknown>): DataCenterFields {
  return {
    siteId: String(fields.siteId ?? '').trim(),
    name: String(fields.name ?? '').trim(),
    isContentOnly: toBool(fields.isContentOnly, false),
    isEnabled: toBool(fields.isEnabled, true),
    servers: parseServers(fields.servers),
  }
}
