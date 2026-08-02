// =============================================================================
// BYOL infrastructure request validation (pure) — node_tiers-native.
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (per-tier counts + cluster placement) — can be
// unit tested without pulling in Fastify or the platform DB.
//
// The SDK's <ByolInfrastructureManager> sends a generic `tiers: [{ key, count,
// placement }]` array. This app declares TWO scalable tiers (see
// client/pages/BYOLPage.tsx's `topology` prop and lib/byolTopology.ts):
//   • tiers['server'] → authentik server nodes (web/API, the ALB targets)
//   • tiers['worker'] → authentik worker nodes (background tasks — same image,
//     started with the `worker` command instead of `server`)
//
// Unlike the legacy Splunk-shaped apps there are NO indexerCount/searchHeadCount
// scalar fields here: counts + placement are read ONLY from the `tiers` array
// and persisted ONLY in the `node_tiers` JSONB column. `readByol` always emits
// `nodeTiers` in declared order [server, worker].
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** authentik's two scalable BYOL node tiers, in persisted/display order. */
const TIER_KEYS = ['server', 'worker'] as const
type TierKey = (typeof TIER_KEYS)[number]

/** Error-message labels — must match client/pages/BYOLPage.tsx's `topology.tiers[].label`. */
const TIER_LABELS: Record<TierKey, string> = {
  server: 'Server nodes',
  worker: 'Worker nodes',
}

/**
 * Minimum node count per tier. Both the server (web/API) and worker
 * (background tasks) tiers stay permissive (≥1): a single server is a complete
 * authentik control plane and one worker is enough to process scheduled tasks
 * and outpost connections. A single-node / eval deployment collapses to one
 * all-in-one box, so every tier is effectively ≥1 there too.
 */
function tierMinimum(_key: TierKey): number {
  return 1
}

/** A single tier's persisted count + placement, as sent by the SDK form (`{ key, count, placement }`). */
export interface NodeTierInput {
  key: string
  count: number
  placement: ClusterPlacement | null
}

interface ParsedTier {
  count: number
  placement: ClusterPlacement | null
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/**
 * Parse the generic `tiers` array the SDK form sends, keyed by tier id. Returns
 * an empty map (never null) when `tiers` is absent or malformed, so callers can
 * uniformly fall back per-key to a default count of 1.
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

  // "Distributed" is the multi-node authentik stack (server + worker nodes +
  // PostgreSQL on separate nodes); single instance is the all-in-one box.
  const isDistributed = deploymentType === 'distributed'

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

  // Generic per-tier node counts + placement (the SDK form's `tiers` array,
  // keyed to this app's declared topology — see client/pages/BYOLPage.tsx).
  const tiers = parseTiers(body)
  const nodeTiers: NodeTierInput[] = []
  for (const key of TIER_KEYS) {
    const parsed = tiers.get(key)
    const count = parsed ? parsed.count : 1
    const minimum = tierMinimum(key)
    if (count < minimum) {
      return { data: {}, error: `${TIER_LABELS[key]} must be at least ${minimum}` }
    }
    // Placement is only meaningful for a distributed deployment; single instance
    // collapses to a single all-in-one box.
    const placement = isDistributed ? parsed?.placement ?? null : null
    if (isDistributed) {
      const placementErr = validatePlacement(placement, count)
      if (placementErr) return { data: {}, error: `${TIER_LABELS[key]} placement: ${placementErr}` }
      // Multi-region (region granularity) provisions per-region satellite VPCs
      // peered back to the main region — which requires a dedicated (BYOC) cloud
      // fabric the module owns (a hosted/shared network is a single looked-up VPC).
      if (placement?.mode === 'multi-site' && placement.granularity === 'region' && networkMode !== 'dedicated') {
        return {
          data: {},
          error: `${TIER_LABELS[key]} placement: multi-region placement requires a dedicated cloud fabric (BYOC) — set the deployment network to "dedicated".`,
        }
      }
    }
    nodeTiers.push({ key, count, placement })
  }

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one forwarder).
  // Carried on the record for SDK-form round-tripping; unused by authentik's
  // resource plan (authentik has no consolidated control plane / forwarder tier).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1

  // Compute size override; empty/whitespace → null (use the cloud default).
  const instanceTypeRaw = typeof body?.instanceType === 'string' ? body.instanceType.trim() : ''
  const instanceType = instanceTypeRaw || null

  const data: Record<string, unknown> = {
    name,
    deploymentType,
    environmentType,
    hosting_type: hostingType,
    region,
    networkMode,
    dnsMode,
    controlPlaneLayout,
    heavyForwarderCount,
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
