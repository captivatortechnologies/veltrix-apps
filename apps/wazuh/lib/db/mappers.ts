// =============================================================================
// Row mappers — translate raw snake_case Postgres rows from the app's own
// tables into the camelCase shapes the API and client pages already expect.
//
// The app talks to its tables through the platform's raw-query escape hatches
// ($queryRawUnsafe / $executeRawUnsafe); there is no generated Prisma model for
// an app-owned table. These mappers are the single place that shape is defined.
// =============================================================================

import {
  parsePlacement,
  normalizeControlPlaneLayout,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from '../byolPlacement'

export type Row = Record<string, any>

export interface RegionDto {
  id: string
  region: string
  infrastructureId: string
  customerId: string
  createdAt: Date
  updatedAt: Date
}

export function mapRegion(r: Row): RegionDto {
  return {
    id: r.id,
    region: r.region,
    infrastructureId: r.infrastructure_id,
    customerId: r.customer_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** A single tier's persisted count + placement — the generic replacement for
 *  the fixed indexerCount/searchHeadCount pair (SDK's `ByolTierValue`). */
export interface ByolTierDto {
  key: string
  count: number
  placement: ClusterPlacement | null
}

export interface ByolDto {
  id: string
  name: string
  deploymentType: string
  environmentType: string
  indexerCount: number
  searchHeadCount: number
  /** Generic per-tier node counts + placement, in display order [indexer, worker]. */
  tiers: ByolTierDto[]
  status: string
  customerId: string
  cloudProviderId: string | null
  // Kept snake_case to preserve the existing API contract.
  hosting_type: string
  region: string | null
  // Deployment target (hosted vs BYOC).
  networkMode: string
  dnsMode: string
  cloudAccountConnectionId: string | null
  // Topology authoring (control-plane consolidation, dashboards, placement).
  controlPlaneLayout: ControlPlaneLayout
  heavyForwarderCount: number
  indexerPlacement: ClusterPlacement | null
  searchHeadPlacement: ClusterPlacement | null
  /** Compute size override for every node; null = cloud default. */
  instanceType: string | null
  createdAt: Date
  updatedAt: Date
  indexerRegions: RegionDto[]
  searchHeadRegions: RegionDto[]
}

/**
 * Parse the `node_tiers` JSONB column (a JS array once the pg driver decodes
 * it, or a JSON string in the rarer raw-text path) into the DTO's ordered
 * tier list. Malformed / missing rows (pre-migration data not yet backfilled)
 * fall back to an empty array — the SDK's `tierValue()` reads the legacy
 * indexerCount/searchHeadCount columns for those.
 */
function parseNodeTiers(value: unknown): ByolTierDto[] {
  let arr: any = value
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((t) => t && typeof t === 'object' && typeof t.key === 'string')
    .map((t) => ({
      key: t.key,
      count: Number(t.count) || 0,
      placement: parsePlacement(t.placement),
    }))
}

export function mapByol(r: Row): ByolDto {
  return {
    id: r.id,
    name: r.name,
    deploymentType: r.deployment_type,
    environmentType: r.environment_type,
    indexerCount: r.indexer_count,
    searchHeadCount: r.search_head_count,
    tiers: parseNodeTiers(r.node_tiers),
    status: r.status,
    customerId: r.customer_id,
    cloudProviderId: r.cloud_provider_id ?? null,
    hosting_type: r.hosting_type,
    region: r.region ?? null,
    networkMode: r.network_mode ?? 'shared',
    dnsMode: r.dns_mode ?? 'managed',
    cloudAccountConnectionId: r.cloud_account_connection_id ?? null,
    controlPlaneLayout: normalizeControlPlaneLayout(r.control_plane_layout),
    heavyForwarderCount: Number(r.heavy_forwarder_count ?? 1),
    indexerPlacement: parsePlacement(r.indexer_placement),
    searchHeadPlacement: parsePlacement(r.search_head_placement),
    instanceType: r.instance_type ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    indexerRegions: [],
    searchHeadRegions: [],
  }
}
