// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, redis count, cluster
// placement) — can be unit tested without pulling in Fastify or the platform DB.
//
// The SDK's ByolInfrastructureManager posts a generic `tiers: [{key, count,
// placement}]` array (its N-tier topology contract) instead of the old fixed
// indexerCount/searchHeadCount/indexerPlacement/searchHeadPlacement fields.
// Fleet's own two tiers map onto those same legacy names so the rest of the
// app (lib/byolTopology.ts, the DB columns) keeps working unchanged:
//   • tiers[key=database] → indexerCount / indexerPlacement (MySQL/MariaDB)
//   • tiers[key=server]   → searchHeadCount / searchHeadPlacement (fleet-server)
// The legacy indexerCount/searchHeadCount/indexerPlacement/searchHeadPlacement
// body fields are still accepted as a fallback when `tiers` is absent.
//
// Region associations (indexerRegions / searchHeadRegions) are intentionally NOT
// written here.
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** Fleet's two BYOL tiers, in storage/display order. */
type FleetTierKey = 'database' | 'server'

interface TierDef {
  key: FleetTierKey
  /** Human label used in validation error messages (never "indexer"/"search head"). */
  label: string
  /** Minimum count regardless of deployment type. */
  baseMin: number
  /** Minimum count required for a distributed deployment. */
  distributedMin: number
}

const TIER_DEFS: TierDef[] = [
  { key: 'database', label: 'Database nodes', baseMin: 1, distributedMin: 1 },
  { key: 'server', label: 'Fleet servers', baseMin: 1, distributedMin: 2 },
]

interface TierValue {
  key: FleetTierKey
  count: number
  placement: ClusterPlacement | null
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Collapse single-site placement to `null` for storage — matches the legacy
 *  indexer_placement/search_head_placement JSONB columns' write semantics
 *  (see `placementJson` in lib/db/byol.ts), so `node_tiers` stays consistent
 *  with them. */
function forStorage(placement: ClusterPlacement | null): ClusterPlacement | null {
  return placement && placement.mode === 'multi-site' ? placement : null
}

/**
 * Read one tier's count + placement from the request body. Prefers the
 * generic `body.tiers` array (matched by `key`); falls back to the legacy
 * flat fields when `tiers` is absent (back-compat with pre-topology callers).
 */
function readTier(
  tiersByKey: Map<string, any> | null,
  key: FleetTierKey,
  legacyCount: unknown,
  legacyPlacement: unknown,
  isDistributed: boolean,
): TierValue {
  const fromTiers = tiersByKey?.get(key)
  const count = fromTiers ? toInt(fromTiers.count, 1) : toInt(legacyCount, 1)
  const placementRaw = fromTiers ? fromTiers.placement : legacyPlacement
  const placement = isDistributed ? parsePlacement(placementRaw) : null
  return { key, count, placement }
}

/** Coerce + validate an editable BYOL infrastructure record from a request body. */
export function readByol(body: any): { data: Record<string, unknown>; error?: string } {
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return { data: {}, error: 'Name is required' }
  if (name.length > 120) return { data: {}, error: 'Name must be 120 characters or fewer' }

  const deploymentType = typeof body?.deploymentType === 'string' ? body.deploymentType.trim() : 'single'
  const environmentType = typeof body?.environmentType === 'string' ? body.environmentType.trim() : ''
  // Provider name (a platform cloud-provider name, or "Self-Hosted"); no default.
  const hostingType = typeof body?.hosting_type === 'string' ? body.hosting_type.trim() : ''
  // Cloud region (only meaningful for a distributed cloud deployment).
  const region = typeof body?.region === 'string' ? body.region.trim() : ''

  // "Distributed" is the multi-node Fleet stack (single instance is the other).
  const isDistributed = deploymentType === 'distributed'

  const rawTiers = Array.isArray(body?.tiers) ? body.tiers : null
  const tiersByKey = rawTiers
    ? new Map<string, any>(rawTiers.filter((t: any) => t && typeof t.key === 'string').map((t: any) => [t.key, t]))
    : null

  const database = readTier(tiersByKey, 'database', body?.indexerCount, body?.indexerPlacement, isDistributed)
  const server = readTier(tiersByKey, 'server', body?.searchHeadCount, body?.searchHeadPlacement, isDistributed)
  const tiers: Record<FleetTierKey, TierValue> = { database, server }

  for (const def of TIER_DEFS) {
    if (tiers[def.key].count < def.baseMin) {
      return { data: {}, error: `${def.label} must be at least ${def.baseMin}` }
    }
  }
  if (isDistributed) {
    for (const def of TIER_DEFS) {
      if (tiers[def.key].count < def.distributedMin) {
        return { data: {}, error: `Distributed deployments require at least ${def.distributedMin} ${def.label}` }
      }
    }
  }

  const indexerCount = database.count
  const searchHeadCount = server.count
  const tierEntries = TIER_DEFS.map((def) => [def, tiers[def.key]] as const)

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one redis, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1
  const indexerPlacement = database.placement
  const searchHeadPlacement = server.placement
  if (isDistributed) {
    for (const [def, tier] of tierEntries) {
      const err = validatePlacement(tier.placement, tier.count)
      if (err) return { data: {}, error: `${def.label} placement: ${err}` }
    }
    // Multi-region (region granularity) provisions per-region satellite VPCs peered
    // back to the main region — which requires a dedicated (BYOC) cloud fabric the
    // module owns (a hosted/shared network is a single looked-up VPC). Require it.
    const networkModeRaw = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
    for (const [def, tier] of tierEntries) {
      const p = tier.placement
      if (p?.mode === 'multi-site' && p.granularity === 'region' && networkModeRaw !== 'dedicated') {
        return {
          data: {},
          error: `${def.label} placement: multi-region placement requires a dedicated cloud fabric (BYOC) — set the deployment network to "dedicated".`,
        }
      }
    }
  }

  // Deployment target: shared = Veltrix-hosted; dedicated/existing = BYOC (into
  // the customer's own cloud account). Defaults keep hosted behaviour unchanged.
  const networkMode = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
  if (!['shared', 'dedicated', 'existing'].includes(networkMode)) {
    return { data: {}, error: 'networkMode must be one of: shared, dedicated, existing' }
  }
  const dnsMode = typeof body?.dnsMode === 'string' ? body.dnsMode.trim() : 'managed'
  if (!['managed', 'delegated', 'private-only'].includes(dnsMode)) {
    return { data: {}, error: 'dnsMode must be one of: managed, delegated, private-only' }
  }
  const cloudAccountConnectionId =
    typeof body?.cloudAccountConnectionId === 'string' ? body.cloudAccountConnectionId.trim() : ''
  // BYOC modes must name the cloud account to deploy into.
  if ((networkMode === 'dedicated' || networkMode === 'existing') && !cloudAccountConnectionId) {
    return { data: {}, error: 'A cloud account is required when deploying into your own cloud (dedicated/existing)' }
  }

  // Compute size override; empty/whitespace → null (use the cloud default).
  const instanceTypeRaw = typeof body?.instanceType === 'string' ? body.instanceType.trim() : ''
  const instanceType = instanceTypeRaw || null

  const data: Record<string, unknown> = {
    name,
    deploymentType,
    environmentType,
    hosting_type: hostingType,
    region,
    indexerCount,
    searchHeadCount,
    // Normalized per-tier storage — [database, server], the app's fixed
    // display/storage order — persisted to the node_tiers JSONB column.
    nodeTiers: [
      { key: 'database', count: indexerCount, placement: forStorage(indexerPlacement) },
      { key: 'server', count: searchHeadCount, placement: forStorage(searchHeadPlacement) },
    ],
    networkMode,
    dnsMode,
    controlPlaneLayout,
    heavyForwarderCount,
    indexerPlacement,
    searchHeadPlacement,
    instanceType,
  }
  // cloudProviderId is optional (String?); only set when explicitly provided.
  if (typeof body?.cloudProviderId === 'string' && body.cloudProviderId.trim()) {
    data.cloudProviderId = body.cloudProviderId.trim()
  }
  if (cloudAccountConnectionId) {
    data.cloudAccountConnectionId = cloudAccountConnectionId
  }
  return { data }
}
