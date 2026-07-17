// =============================================================================
// BYOL infrastructure — raw-SQL access to the app-owned
// `splunk_byol_infrastructure` table (and its region satellites).
//
// `customerId` and `cloudProviderId` are plain columns referencing PLATFORM
// entities; the app never foreign-keys across the boundary.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapByol, mapRegion, type ByolDto, type RegionDto, type Row } from './mappers'
import {
  normalizeControlPlaneLayout,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from '../byolPlacement'
import { recordStateEvent } from './usage'

/** Serialize a placement for a JSONB column (null when single-site / absent). */
function placementJson(placement?: ClusterPlacement | null): string | null {
  if (!placement || placement.mode !== 'multi-site') return null
  return JSON.stringify(placement)
}

/** Append a lifecycle state event for an infra (foundation for node-hours billing). */
async function emitStateEvent(db: PlatformDatabaseClient, infra: ByolDto, status: string): Promise<void> {
  await recordStateEvent(db, {
    infrastructureId: infra.id,
    customerId: infra.customerId,
    status,
    nodeCount: infra.indexerCount + infra.searchHeadCount,
  })
}

export interface ByolInput {
  name: string
  deploymentType: string
  environmentType: string
  hosting_type: string
  region?: string
  indexerCount: number
  searchHeadCount: number
  cloudProviderId?: string
  // Deployment target (hosted vs BYOC) — see migration 009.
  networkMode?: string
  dnsMode?: string
  cloudAccountConnectionId?: string
  // Topology authoring (control-plane consolidation, forwarders, placement) — see migration 010.
  controlPlaneLayout?: ControlPlaneLayout
  heavyForwarderCount?: number
  indexerPlacement?: ClusterPlacement | null
  searchHeadPlacement?: ClusterPlacement | null
}

async function attachRegions(db: PlatformDatabaseClient, infra: ByolDto): Promise<ByolDto> {
  const [indexer, searchHead] = await Promise.all([
    db.$queryRawUnsafe<Row[]>(
      'SELECT * FROM splunk_byol_indexer_region WHERE infrastructure_id = $1::uuid',
      infra.id,
    ),
    db.$queryRawUnsafe<Row[]>(
      'SELECT * FROM splunk_byol_search_head_region WHERE infrastructure_id = $1::uuid',
      infra.id,
    ),
  ])
  infra.indexerRegions = indexer.map(mapRegion)
  infra.searchHeadRegions = searchHead.map(mapRegion)
  return infra
}

export async function listByol(db: PlatformDatabaseClient, customerId: string): Promise<ByolDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_infrastructure WHERE customer_id = $1::uuid ORDER BY updated_at DESC',
    customerId,
  )
  return Promise.all(rows.map((r) => attachRegions(db, mapByol(r))))
}

export async function getByol(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<ByolDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_infrastructure WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
  return rows[0] ? attachRegions(db, mapByol(rows[0])) : null
}

export async function createByol(
  db: PlatformDatabaseClient,
  customerId: string,
  input: ByolInput,
): Promise<ByolDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    // A freshly created infrastructure has not been deployed yet, so it starts in
    // 'not_started' — the deploy route is what moves it to 'provisioning'.
    `INSERT INTO splunk_byol_infrastructure
       (name, deployment_type, environment_type, hosting_type, region,
        indexer_count, search_head_count, cloud_provider_id, customer_id, status,
        network_mode, dns_mode, cloud_account_connection_id,
        control_plane_layout, heavy_forwarder_count, indexer_placement, search_head_placement)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9::uuid, 'not_started',
             $10, $11, $12::uuid,
             $13, $14, $15::jsonb, $16::jsonb)
     RETURNING *`,
    input.name,
    input.deploymentType,
    input.environmentType,
    input.hosting_type,
    input.region ?? null,
    input.indexerCount,
    input.searchHeadCount,
    input.cloudProviderId ?? null,
    customerId,
    input.networkMode ?? 'shared',
    input.dnsMode ?? 'managed',
    input.cloudAccountConnectionId ?? null,
    normalizeControlPlaneLayout(input.controlPlaneLayout),
    Math.max(1, Math.floor(input.heavyForwarderCount ?? 1)),
    placementJson(input.indexerPlacement),
    placementJson(input.searchHeadPlacement),
  )
  const created = mapByol(rows[0])
  await emitStateEvent(db, created, created.status) // 'not_started'
  return attachRegions(db, created)
}

export async function updateByol(
  db: PlatformDatabaseClient,
  id: string,
  input: ByolInput,
): Promise<ByolDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `UPDATE splunk_byol_infrastructure SET
       name = $2, deployment_type = $3, environment_type = $4, hosting_type = $5,
       region = $6, indexer_count = $7, search_head_count = $8,
       cloud_provider_id = COALESCE($9::uuid, cloud_provider_id),
       control_plane_layout = $10, heavy_forwarder_count = $11,
       indexer_placement = $12::jsonb, search_head_placement = $13::jsonb,
       updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    id,
    input.name,
    input.deploymentType,
    input.environmentType,
    input.hosting_type,
    input.region ?? null,
    input.indexerCount,
    input.searchHeadCount,
    input.cloudProviderId ?? null,
    normalizeControlPlaneLayout(input.controlPlaneLayout),
    Math.max(1, Math.floor(input.heavyForwarderCount ?? 1)),
    placementJson(input.indexerPlacement),
    placementJson(input.searchHeadPlacement),
  )
  return attachRegions(db, mapByol(rows[0]))
}

export async function setByolStatus(
  db: PlatformDatabaseClient,
  id: string,
  status: string,
): Promise<ByolDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'UPDATE splunk_byol_infrastructure SET status = $2, updated_at = now() WHERE id = $1::uuid RETURNING *',
    id,
    status,
  )
  const updated = mapByol(rows[0])
  await emitStateEvent(db, updated, updated.status)
  return attachRegions(db, updated)
}

export async function deleteByol(db: PlatformDatabaseClient, id: string): Promise<void> {
  // Record a terminal 'decommissioned' event before the row goes away so
  // node-hours accrual stops at deletion (state_event.infrastructure_id is a
  // plain UUID with no FK, so it survives the delete for billing history).
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM splunk_byol_infrastructure WHERE id = $1::uuid',
    id,
  )
  if (rows[0]) await emitStateEvent(db, mapByol(rows[0]), 'decommissioned')
  await db.$executeRawUnsafe('DELETE FROM splunk_byol_infrastructure WHERE id = $1::uuid', id)
}

/** Set status by id only, no-op if the infrastructure does not exist. Returns whether a row was updated. */
export async function setByolStatusIfExists(
  db: PlatformDatabaseClient,
  id: string,
  status: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'UPDATE splunk_byol_infrastructure SET status = $2, updated_at = now() WHERE id = $1::uuid RETURNING *',
    id,
    status,
  )
  if (!rows[0]) return false
  await emitStateEvent(db, mapByol(rows[0]), status)
  return true
}

/** Minimal id-only lookup (name + customer) for internal event handling. No
 *  customer scoping — bus events are already platform-trusted, and onEvent has
 *  the infra id but not the customer id. */
export async function getByolCore(
  db: PlatformDatabaseClient,
  id: string,
): Promise<{ id: string; name: string; customerId: string } | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT id, name, customer_id FROM splunk_byol_infrastructure WHERE id = $1::uuid',
    id,
  )
  const r = rows[0]
  return r ? { id: String(r.id), name: String(r.name), customerId: String(r.customer_id) } : null
}

export type { RegionDto }
