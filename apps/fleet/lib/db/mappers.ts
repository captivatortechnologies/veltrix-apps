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

/** One BYOL node tier's persisted count + placement (the SDK's generic per-tier shape). */
export interface ByolTierValue {
  key: string
  count: number
  placement: ClusterPlacement | null
}

/**
 * Parse the `node_tiers` JSONB column (object array from the pg driver, or a
 * JSON string) into the SDK's `ByolTierValue[]` shape. Malformed/empty input
 * yields `[]`; the caller decides whether an empty result should surface as
 * `undefined` so the SDK's legacy indexerCount/searchHeadCount fallback kicks in.
 */
function parseNodeTiers(value: unknown): ByolTierValue[] {
  let arr: unknown = value
  if (typeof value === 'string') {
    try {
      arr = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((t): t is Row => Boolean(t) && typeof t.key === 'string')
    .map((t) => {
      const count = Number(t.count)
      return {
        key: t.key,
        count: Number.isFinite(count) ? Math.trunc(count) : 1,
        placement: parsePlacement(t.placement),
      }
    })
}

export interface ByolDto {
  id: string
  name: string
  deploymentType: string
  environmentType: string
  /** @deprecated Kept for back-compat; the source of truth is `tiers[0]` ("database"). */
  indexerCount: number
  /** @deprecated Kept for back-compat; the source of truth is `tiers[1]` ("server"). */
  searchHeadCount: number
  /** Generic per-tier node counts + placement — [database, server] — the SDK's app-agnostic topology contract. */
  tiers?: ByolTierValue[]
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
  // Topology authoring (control-plane consolidation, redis, placement).
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

export function mapByol(r: Row): ByolDto {
  const tiers = parseNodeTiers(r.node_tiers)
  return {
    id: r.id,
    name: r.name,
    deploymentType: r.deployment_type,
    environmentType: r.environment_type,
    indexerCount: r.indexer_count,
    searchHeadCount: r.search_head_count,
    // Empty stays `undefined` (never `[]`) so the SDK's per-row fallback to
    // indexerCount/searchHeadCount (keyed on `tiers` being falsy) still fires
    // for any row a migration/backfill has not reached.
    tiers: tiers.length > 0 ? tiers : undefined,
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
