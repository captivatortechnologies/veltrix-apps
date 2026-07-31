// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, heavy forwarders, cluster
// placement) — can be unit tested without pulling in Fastify or the platform DB.
//
// The SDK's ByolInfrastructureManager sends a generic `tiers: [{ key, count,
// placement }]` array (the app-agnostic replacement for the old fixed
// indexerCount/searchHeadCount pair). Splunk declares two tiers matching its
// original topology:
//   • tier 'indexer'    → indexer cluster peers   [data tier]
//   • tier 'searchHead' → search head cluster members [search tier]
// This module unpacks `body.tiers` back into the legacy indexerCount /
// searchHeadCount / indexerPlacement / searchHeadPlacement fields the rest of
// the app (byolTopology.ts, the DB layer's legacy columns) already speaks, and
// also exposes them as an ordered `nodeTiers` array for the `node_tiers`
// column. A request from an older client with no `tiers` field falls back to
// those legacy top-level fields directly.
//
// Region associations (indexerRegions / searchHeadRegions) and the splunkUpgrade
// relation are intentionally NOT written here.
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** Splunk's two BYOL node tiers, keyed to match client/pages/BYOLPage.tsx's `topology.tiers`. */
type NodeTierKey = 'indexer' | 'searchHead'

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
  // Provider name (a platform cloud-provider name, or "Self-Hosted"); no default
  // — Kubernetes is no longer a hosting option.
  const hostingType = typeof body?.hosting_type === 'string' ? body.hosting_type.trim() : ''
  // Cloud region (only meaningful for a distributed cloud deployment).
  const region = typeof body?.region === 'string' ? body.region.trim() : ''

  // Generic per-tier node counts + placement (SDK's `tiers: [{ key, count,
  // placement }]`), falling back to the legacy top-level fields for a client
  // that predates the generic-topology rollout.
  const tiersRaw = body?.tiers
  const hasTiers = Array.isArray(tiersRaw)
  const indexerTier = findTier(tiersRaw, 'indexer')
  const searchHeadTier = findTier(tiersRaw, 'searchHead')

  const indexerCount = toInt(hasTiers ? indexerTier?.count : body?.indexerCount, 1)
  const searchHeadCount = toInt(hasTiers ? searchHeadTier?.count : body?.searchHeadCount, 1)
  if (indexerCount < 1) return { data: {}, error: 'indexerCount must be at least 1' }
  if (searchHeadCount < 1) return { data: {}, error: 'searchHeadCount must be at least 1' }

  // "Distributed" is the multi-node Splunk topology (single instance is the other).
  const isDistributed = deploymentType === 'distributed'
  if (isDistributed) {
    if (indexerCount < 3) return { data: {}, error: 'Distributed deployments require at least 3 indexers' }
    if (searchHeadCount < 2) return { data: {}, error: 'Distributed deployments require at least 2 search heads' }
  }

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one forwarder, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1
  const indexerPlacementRaw = hasTiers ? indexerTier?.placement : body?.indexerPlacement
  const searchHeadPlacementRaw = hasTiers ? searchHeadTier?.placement : body?.searchHeadPlacement
  const indexerPlacement = isDistributed ? parsePlacement(indexerPlacementRaw) : null
  const searchHeadPlacement = isDistributed ? parsePlacement(searchHeadPlacementRaw) : null
  if (isDistributed) {
    const indexerErr = validatePlacement(indexerPlacement, indexerCount)
    if (indexerErr) return { data: {}, error: `Indexer placement: ${indexerErr}` }
    const searchErr = validatePlacement(searchHeadPlacement, searchHeadCount)
    if (searchErr) return { data: {}, error: `Search head placement: ${searchErr}` }
    // Multi-region (region granularity) provisions per-region satellite VPCs peered
    // back to the main region — which requires a dedicated (BYOC) cloud fabric the
    // module owns (a hosted/shared network is a single looked-up VPC). Require it.
    const networkModeRaw = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
    for (const [label, p] of [
      ['Indexer', indexerPlacement],
      ['Search head', searchHeadPlacement],
    ] as const) {
      if (p?.mode === 'multi-site' && p.granularity === 'region' && networkModeRaw !== 'dedicated') {
        return {
          data: {},
          error: `${label} placement: multi-region placement requires a dedicated cloud fabric (BYOC) — set the deployment network to "dedicated".`,
        }
      }
    }
  }

  // Ordered [indexer, searchHead] tier snapshot for the generic `node_tiers`
  // column — the app-agnostic replacement for reading indexerCount/
  // searchHeadCount off discrete columns. Mirrors what the SDK form always
  // sends when `tiers` is present; derived from the legacy fields either way
  // so it's always populated.
  const nodeTiers: NodeTierInput[] = [
    { key: 'indexer', count: indexerCount, placement: indexerPlacement },
    { key: 'searchHead', count: searchHeadCount, placement: searchHeadPlacement },
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

  // Selected Splunk version (a splunk_version catalog entry id); empty/absent →
  // null, meaning the deploy uses its own default installer/version.
  const versionIdRaw = typeof body?.versionId === 'string' ? body.versionId.trim() : ''
  const versionId = versionIdRaw || null

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
    versionId,
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
