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

export interface LowLevelCategoryRef {
  id?: number
  name?: string
  severity?: number
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

/** A log source group as returned by GET .../log_source_management/log_source_groups. */
export interface LogSourceGroupRef {
  id?: number
  name?: string
  description?: string
  parent_id?: number
  owner?: string
  modification_date?: number
  assignable?: boolean
  child_group_ids?: number[]
}

/** A tagged-field category as returned by GET /ariel/taggedfieldcategories. */
export interface TaggedFieldCategoryRef {
  id?: number
  name?: string
  uuid?: string
  creation_date?: number
  modified_date?: number
}

/** A retention bucket as returned by GET /config/event_retention_buckets or /config/flow_retention_buckets. */
export interface RetentionBucketRef {
  id?: number
  name?: string
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

export function listLowLevelCategories(client: QRadarClient): Promise<LowLevelCategoryRef[]> {
  return listJson<LowLevelCategoryRef>(client, '/data_classification/low_level_categories')
}

export function listLogSourceGroups(client: QRadarClient): Promise<LogSourceGroupRef[]> {
  return listJson<LogSourceGroupRef>(client, '/config/event_sources/log_source_management/log_source_groups')
}

export function listTaggedFieldCategories(client: QRadarClient): Promise<TaggedFieldCategoryRef[]> {
  return listJson<TaggedFieldCategoryRef>(client, '/ariel/taggedfieldcategories')
}

/** Event retention buckets are read-only here (no create endpoint); used only to
 * resolve a bucket NAME to its id for the disaster-recovery Ariel Copy Profile
 * exclude-list fields. */
export function listEventRetentionBuckets(client: QRadarClient): Promise<RetentionBucketRef[]> {
  return listJson<RetentionBucketRef>(client, '/config/event_retention_buckets')
}

/** Flow retention buckets — see listEventRetentionBuckets. */
export function listFlowRetentionBuckets(client: QRadarClient): Promise<RetentionBucketRef[]> {
  return listJson<RetentionBucketRef>(client, '/config/flow_retention_buckets')
}

/** Build a case-insensitive name -> id index from a list of named references. */
export function indexByLowerName(refs: Array<{ id?: number; name?: string }>): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of refs) if (r.name && typeof r.id === 'number') m.set(r.name.toLowerCase(), r.id)
  return m
}
