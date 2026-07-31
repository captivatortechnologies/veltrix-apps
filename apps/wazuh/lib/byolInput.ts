// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, dashboard count, cluster
// placement) — can be unit tested without pulling in Fastify or the platform DB.
//
// The SDK's ByolInfrastructureManager sends a generic `tiers: [{ key, count,
// placement }]` array (the app-agnostic replacement for the old fixed
// indexerCount/searchHeadCount pair). Wazuh declares two tiers, matching
// lib/byolTopology.ts's node-role mapping:
//   • tier 'indexer' → Wazuh indexer (OpenSearch) nodes   [data tier]
//   • tier 'worker'  → Wazuh manager worker nodes         [control-plane]
// This module unpacks `body.tiers` back into the legacy indexerCount /
// searchHeadCount / indexerPlacement / searchHeadPlacement fields the rest of
// the app (byolTopology.ts, the DB layer's legacy columns) already speaks, and
// also exposes them as an ordered `nodeTiers` array for the new `node_tiers`
// column. Requests from an older client with no `tiers` field fall back to
// those legacy top-level fields directly.
//
// Region associations (indexerRegions / searchHeadRegions) are intentionally NOT
// written here.
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** Wazuh's two BYOL node tiers, keyed to match client/pages/BYOLPage.tsx's `topology.tiers`. */
type NodeTierKey = 'indexer' | 'worker'

/** Display labels for validation error messages — mirrors the SDK form's `${tier.label}` convention. */
const TIER_LABELS: Record<NodeTierKey, string> = {
  indexer: 'Indexers',
  worker: 'Manager workers',
}

/** Distributed-deployment minimums: indexer quorum (OpenSearch) and worker HA. */
const TIER_MINIMUMS: Record<NodeTierKey, number> = {
  indexer: 3,
  worker: 2,
}

export interface NodeTierInput {
  key: NodeTierKey
  count: number
  placement: ClusterPlacement | null
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Look up a tier entry by key from a `body.tiers` array (undefined when absent/malformed). */
function findTier(tiers: unknown, key: NodeTierKey): { count?: unknown; placement?: unknown } | undefined {
  if (!Array.isArray(tiers)) return undefined
  return tiers.find((t) => t && typeof t === 'object' && (t as any).key === key) as
    | { count?: unknown; placement?: unknown }
    | undefined
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

  // Generic per-tier node counts + placement (SDK's `tiers: [{ key, count,
  // placement }]`), falling back to the legacy top-level fields for a client
  // that predates the generic-topology rollout.
  const tiersRaw = body?.tiers
  const indexerTier = findTier(tiersRaw, 'indexer')
  const workerTier = findTier(tiersRaw, 'worker')
  const hasTiers = Array.isArray(tiersRaw)

  const indexerCount = toInt(hasTiers ? indexerTier?.count : body?.indexerCount, 1)
  const searchHeadCount = toInt(hasTiers ? workerTier?.count : body?.searchHeadCount, 1)
  if (indexerCount < 1) return { data: {}, error: `${TIER_LABELS.indexer} must be at least 1` }
  if (searchHeadCount < 1) return { data: {}, error: `${TIER_LABELS.worker} must be at least 1` }

  // "Distributed" is the multi-node Wazuh cluster (single instance is the other).
  const isDistributed = deploymentType === 'distributed'
  if (isDistributed) {
    // At least 3 indexer (OpenSearch) nodes for cluster quorum; at least 2 manager
    // workers for agent-capacity HA.
    if (indexerCount < TIER_MINIMUMS.indexer) {
      return { data: {}, error: `Distributed deployments require at least ${TIER_MINIMUMS.indexer} ${TIER_LABELS.indexer.toLowerCase()}` }
    }
    if (searchHeadCount < TIER_MINIMUMS.worker) {
      return { data: {}, error: `Distributed deployments require at least ${TIER_MINIMUMS.worker} ${TIER_LABELS.worker.toLowerCase()}` }
    }
  }

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one dashboard, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1
  const indexerPlacementRaw = hasTiers ? indexerTier?.placement : body?.indexerPlacement
  const searchHeadPlacementRaw = hasTiers ? workerTier?.placement : body?.searchHeadPlacement
  const indexerPlacement = isDistributed ? parsePlacement(indexerPlacementRaw) : null
  const searchHeadPlacement = isDistributed ? parsePlacement(searchHeadPlacementRaw) : null
  if (isDistributed) {
    const indexerErr = validatePlacement(indexerPlacement, indexerCount)
    if (indexerErr) return { data: {}, error: `${TIER_LABELS.indexer} placement: ${indexerErr}` }
    const searchErr = validatePlacement(searchHeadPlacement, searchHeadCount)
    if (searchErr) return { data: {}, error: `${TIER_LABELS.worker} placement: ${searchErr}` }
    // Multi-region (region granularity) provisions per-region satellite VPCs peered
    // back to the main region — which requires a dedicated (BYOC) cloud fabric the
    // module owns (a hosted/shared network is a single looked-up VPC). Require it.
    const networkModeRaw = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
    for (const [label, p] of [
      [TIER_LABELS.indexer, indexerPlacement],
      [TIER_LABELS.worker, searchHeadPlacement],
    ] as const) {
      if (p?.mode === 'multi-site' && p.granularity === 'region' && networkModeRaw !== 'dedicated') {
        return {
          data: {},
          error: `${label} placement: multi-region placement requires a dedicated cloud fabric (BYOC) — set the deployment network to "dedicated".`,
        }
      }
    }
  }

  // Ordered [indexer, worker] tier snapshot for the generic `node_tiers` column
  // — the app-agnostic replacement for reading indexerCount/searchHeadCount off
  // discrete columns. Mirrors what the SDK form always sends when `tiers` is
  // present; derived from the legacy fields either way so it's always populated.
  const nodeTiers: NodeTierInput[] = [
    { key: 'indexer', count: indexerCount, placement: indexerPlacement },
    { key: 'worker', count: searchHeadCount, placement: searchHeadPlacement },
  ]

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
    nodeTiers,
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
