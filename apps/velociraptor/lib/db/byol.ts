// =============================================================================
// BYOL infrastructure — raw-SQL access to the app-owned
// `velociraptor_byol_infrastructure` table.
//
// This app is node_tiers-NATIVE: per-tier node counts are stored ONLY in the
// `node_tiers` JSONB column ([{ key, count, placement }]) — there are no legacy
// indexer_count / search_head_count columns and no per-node region satellite
// tables. `customerId` and `cloudProviderId` are plain columns referencing
// PLATFORM entities; the app never foreign-keys across the boundary.
// =============================================================================

import type { PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import { mapByol, type ByolDto, type NodeTierDto, type Row } from './mappers'
import {
  normalizeControlPlaneLayout,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from '../byolPlacement'
import { recordStateEvent } from './usage'

/** Serialize the generic per-tier `node_tiers` column. Always populated by
 *  `readByol`; a direct store caller that omits it persists an empty list. */
function nodeTiersJson(input: ByolInput): string {
  return JSON.stringify(input.nodeTiers ?? [])
}

/** Total stack nodes across every tier — the node count on a billing state event. */
function nodeCountOf(infra: ByolDto): number {
  return (infra.tiers ?? []).reduce((sum, t) => sum + (Number(t.count) || 0), 0)
}

/** Append a lifecycle state event for an infra (foundation for node-hours billing). */
async function emitStateEvent(db: PlatformDatabaseClient, infra: ByolDto, status: string): Promise<void> {
  await recordStateEvent(db, {
    infrastructureId: infra.id,
    customerId: infra.customerId,
    status,
    nodeCount: nodeCountOf(infra),
  })
}

export interface ByolInput {
  name: string
  deploymentType: string
  environmentType: string
  hosting_type: string
  region?: string
  cloudProviderId?: string
  // Deployment target (hosted vs BYOC).
  networkMode?: string
  dnsMode?: string
  cloudAccountConnectionId?: string
  // Topology authoring (control-plane consolidation).
  controlPlaneLayout?: ControlPlaneLayout
  instanceType?: string | null
  // Generic per-tier node counts + placement (the ONLY node-count storage).
  nodeTiers?: NodeTierDto[]
}

export async function listByol(db: PlatformDatabaseClient, customerId: string): Promise<ByolDto[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM velociraptor_byol_infrastructure WHERE customer_id = $1::uuid ORDER BY updated_at DESC',
    customerId,
  )
  return rows.map(mapByol)
}

export async function getByol(
  db: PlatformDatabaseClient,
  id: string,
  customerId: string,
): Promise<ByolDto | null> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM velociraptor_byol_infrastructure WHERE id = $1::uuid AND customer_id = $2::uuid',
    id,
    customerId,
  )
  return rows[0] ? mapByol(rows[0]) : null
}

export async function createByol(
  db: PlatformDatabaseClient,
  customerId: string,
  input: ByolInput,
): Promise<ByolDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    // A freshly created infrastructure has not been deployed yet, so it starts in
    // 'not_started' — the deploy route is what moves it to 'provisioning'.
    `INSERT INTO velociraptor_byol_infrastructure
       (name, deployment_type, environment_type, hosting_type, region,
        cloud_provider_id, customer_id, status,
        network_mode, dns_mode, cloud_account_connection_id,
        control_plane_layout, instance_type, node_tiers)
     VALUES ($1, $2, $3, $4, $5, $6::uuid, $7::uuid, 'not_started',
             $8, $9, $10::uuid,
             $11, $12, $13::jsonb)
     RETURNING *`,
    input.name,
    input.deploymentType,
    input.environmentType,
    input.hosting_type,
    input.region ?? null,
    input.cloudProviderId ?? null,
    customerId,
    input.networkMode ?? 'shared',
    input.dnsMode ?? 'managed',
    input.cloudAccountConnectionId ?? null,
    normalizeControlPlaneLayout(input.controlPlaneLayout),
    input.instanceType?.trim() || null,
    nodeTiersJson(input),
  )
  const created = mapByol(rows[0])
  await emitStateEvent(db, created, created.status) // 'not_started'
  return created
}

export async function updateByol(
  db: PlatformDatabaseClient,
  id: string,
  input: ByolInput,
): Promise<ByolDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    `UPDATE velociraptor_byol_infrastructure SET
       name = $2, deployment_type = $3, environment_type = $4, hosting_type = $5,
       region = $6,
       cloud_provider_id = COALESCE($7::uuid, cloud_provider_id),
       control_plane_layout = $8, instance_type = $9,
       network_mode = $10, dns_mode = $11, cloud_account_connection_id = $12::uuid,
       node_tiers = $13::jsonb,
       updated_at = now()
     WHERE id = $1::uuid
     RETURNING *`,
    id,
    input.name,
    input.deploymentType,
    input.environmentType,
    input.hosting_type,
    input.region ?? null,
    input.cloudProviderId ?? null,
    normalizeControlPlaneLayout(input.controlPlaneLayout),
    input.instanceType?.trim() || null,
    input.networkMode ?? 'shared',
    input.dnsMode ?? 'managed',
    input.cloudAccountConnectionId ?? null,
    nodeTiersJson(input),
  )
  return mapByol(rows[0])
}

export async function setByolStatus(
  db: PlatformDatabaseClient,
  id: string,
  status: string,
): Promise<ByolDto> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'UPDATE velociraptor_byol_infrastructure SET status = $2, updated_at = now() WHERE id = $1::uuid RETURNING *',
    id,
    status,
  )
  const updated = mapByol(rows[0])
  await emitStateEvent(db, updated, updated.status)
  return updated
}

export async function deleteByol(db: PlatformDatabaseClient, id: string): Promise<void> {
  // Record a terminal 'decommissioned' event before the row goes away so
  // node-hours accrual stops at deletion (state_event.infrastructure_id is a
  // plain UUID with no FK, so it survives the delete for billing history).
  const rows = await db.$queryRawUnsafe<Row[]>(
    'SELECT * FROM velociraptor_byol_infrastructure WHERE id = $1::uuid',
    id,
  )
  if (rows[0]) await emitStateEvent(db, mapByol(rows[0]), 'decommissioned')
  await db.$executeRawUnsafe('DELETE FROM velociraptor_byol_infrastructure WHERE id = $1::uuid', id)
}

/** Set status by id only, no-op if the infrastructure does not exist. Returns whether a row was updated. */
export async function setByolStatusIfExists(
  db: PlatformDatabaseClient,
  id: string,
  status: string,
): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Row[]>(
    'UPDATE velociraptor_byol_infrastructure SET status = $2, updated_at = now() WHERE id = $1::uuid RETURNING *',
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
    'SELECT id, name, customer_id FROM velociraptor_byol_infrastructure WHERE id = $1::uuid',
    id,
  )
  const r = rows[0]
  return r ? { id: String(r.id), name: String(r.name), customerId: String(r.customer_id) } : null
}
