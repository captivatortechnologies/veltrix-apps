// =============================================================================
// Read-only reference lookups.
//
// Several config types write numeric foreign keys (type_id, protocol_type_id,
// log_source_type_id) that a human declares by NAME. These helpers list the
// read-only reference endpoints so deploy/validate can map a name -> id before
// writing. All are plain GETs over the existing client (no new HTTP verb).
// =============================================================================

import { parseJson, type QRadarClient } from './qradar'

export interface LogSourceTypeRef {
  id?: number
  name?: string
  internal?: boolean
  custom?: boolean
  default_protocol_id?: number
}

export interface TenantRef {
  id?: number
  name?: string
  deleted?: boolean
}

export interface UserRoleRef {
  id?: number
  name?: string
}

export interface ProtocolParameterDef {
  id?: number
  name?: string
  required?: boolean
}

export interface ProtocolTypeRef {
  id?: number
  name?: string
  parameters?: ProtocolParameterDef[]
}

async function listJson<T>(client: QRadarClient, path: string): Promise<T[]> {
  const res = await client.request('GET', path, { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<T[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

export function listLogSourceTypes(client: QRadarClient): Promise<LogSourceTypeRef[]> {
  return listJson<LogSourceTypeRef>(client, '/config/event_sources/log_source_management/log_source_types')
}

export function listProtocolTypes(client: QRadarClient): Promise<ProtocolTypeRef[]> {
  return listJson<ProtocolTypeRef>(client, '/config/event_sources/log_source_management/protocol_types')
}

export function listTenantRefs(client: QRadarClient): Promise<TenantRef[]> {
  return listJson<TenantRef>(client, '/config/access/tenant_management/tenants')
}

export function listUserRoles(client: QRadarClient): Promise<UserRoleRef[]> {
  return listJson<UserRoleRef>(client, '/config/access/user_roles')
}

/** Build a case-insensitive name -> id index from a list of named references. */
export function indexByLowerName(refs: Array<{ id?: number; name?: string }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of refs) if (r.name && typeof r.id === 'number') m.set(r.name.toLowerCase(), r.id)
  return m
}
