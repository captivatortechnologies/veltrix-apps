// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, sensor count, cluster
// placement) — can be unit tested without pulling in Fastify or the platform DB.
//
// The SDK's <ByolInfrastructureManager> now sends a generic `tiers: [{ key,
// count, placement }]` array (this app declares two — 'search' and 'heavy', see
// lib/byolTopology.ts and client/pages/BYOLPage.tsx's `topology` prop) instead
// of the old Splunk-shaped indexerCount/searchHeadCount/indexerPlacement/
// searchHeadPlacement fields. Those legacy fields are still ACCEPTED as a
// fallback per-tier (an older client, or a partial `tiers` array) and are
// always POPULATED on the way out via `nodeTiers`, so a legacy-shaped write
// still persists the generic column.
//
// Region associations (indexerRegions / searchHeadRegions) are intentionally NOT
// written here.
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** The app's two BYOL node tiers, in persisted/display order. */
const TIER_KEYS = ['search', 'heavy'] as const
type TierKey = (typeof TIER_KEYS)[number]

/** Error-message labels — must match client/pages/BYOLPage.tsx's `topology.tiers[].label`. */
const TIER_LABELS: Record<TierKey, string> = {
  search: 'Search nodes',
  heavy: 'Heavy nodes',
}

/** Distributed-deployment minimums per tier — must match `topology.tiers[].min`. */
const TIER_MINIMUMS: Record<TierKey, number> = {
  search: 2,
  heavy: 1,
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

interface ParsedTier {
  count: number
  placement: ClusterPlacement | null
}

/**
 * Parse the generic `tiers` array the SDK form now sends, keyed by tier id.
 * Returns an empty map (never null) when `tiers` is absent or malformed, so
 * callers can uniformly fall back per-key to the legacy scalar fields.
 */
function parseTiers(body: any): Map<string, ParsedTier> {
  const map = new Map<string, ParsedTier>()
  if (!Array.isArray(body?.tiers)) return map
  for (const t of body.tiers) {
    if (!t || typeof t.key !== 'string') continue
    map.set(t.key, { count: toInt(t.count, 1), placement: parsePlacement(t.placement) })
  }
  return map
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

  const tiers = parseTiers(body)
  const searchTier = tiers.get('search')
  const heavyTier = tiers.get('heavy')

  const indexerCount = searchTier ? searchTier.count : toInt(body?.indexerCount, 1)
  const searchHeadCount = heavyTier ? heavyTier.count : toInt(body?.searchHeadCount, 1)
  if (indexerCount < 1) return { data: {}, error: `${TIER_LABELS.search} must be at least 1` }
  if (searchHeadCount < 1) return { data: {}, error: `${TIER_LABELS.heavy} must be at least 1` }

  // "Distributed" is the multi-node Security Onion grid (single instance is the other).
  const isDistributed = deploymentType === 'distributed'
  if (isDistributed) {
    if (indexerCount < TIER_MINIMUMS.search) {
      return { data: {}, error: `Distributed deployments require at least ${TIER_MINIMUMS.search} ${TIER_LABELS.search}` }
    }
    if (searchHeadCount < TIER_MINIMUMS.heavy) {
      return { data: {}, error: `Distributed deployments require at least ${TIER_MINIMUMS.heavy} ${TIER_LABELS.heavy}` }
    }
  }

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one sensor, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1
  const indexerPlacement = isDistributed ? (searchTier?.placement ?? parsePlacement(body?.indexerPlacement)) : null
  const searchHeadPlacement = isDistributed ? (heavyTier?.placement ?? parsePlacement(body?.searchHeadPlacement)) : null
  if (isDistributed) {
    const indexerErr = validatePlacement(indexerPlacement, indexerCount)
    if (indexerErr) return { data: {}, error: `${TIER_LABELS.search} placement: ${indexerErr}` }
    const searchErr = validatePlacement(searchHeadPlacement, searchHeadCount)
    if (searchErr) return { data: {}, error: `${TIER_LABELS.heavy} placement: ${searchErr}` }
    // Multi-region (region granularity) provisions per-region satellite VPCs peered
    // back to the main region — which requires a dedicated (BYOC) cloud fabric the
    // module owns (a hosted/shared network is a single looked-up VPC). Require it.
    const networkModeRaw = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
    for (const [label, p] of [
      [TIER_LABELS.search, indexerPlacement],
      [TIER_LABELS.heavy, searchHeadPlacement],
    ] as const) {
      if (p?.mode === 'multi-site' && p.granularity === 'region' && networkModeRaw !== 'dedicated') {
        return {
          data: {},
          error: `${label} placement: multi-region placement requires a dedicated cloud fabric (BYOC) — set the deployment network to "dedicated".`,
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

  // The generic per-tier shape the SDK form and this app's GET responses read,
  // in display order [search, heavy] — populated regardless of which shape the
  // request body used, so a legacy-shaped write still persists `tiers`.
  const nodeTiers = [
    { key: 'search', count: indexerCount, placement: indexerPlacement },
    { key: 'heavy', count: searchHeadCount, placement: searchHeadPlacement },
  ]

  const data: Record<string, unknown> = {
    name,
    deploymentType,
    environmentType,
    hosting_type: hostingType,
    region,
    indexerCount,
    searchHeadCount,
    networkMode,
    dnsMode,
    controlPlaneLayout,
    heavyForwarderCount,
    indexerPlacement,
    searchHeadPlacement,
    instanceType,
    nodeTiers,
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
