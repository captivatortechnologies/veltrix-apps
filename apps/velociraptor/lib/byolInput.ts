// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, cluster placement) — can
// be unit tested without pulling in Fastify or the platform DB.
//
// This app is node_tiers-NATIVE. The SDK's <ByolInfrastructureManager> sends a
// generic `tiers: [{ key, count, placement }]` array; this app declares two
// tiers — 'frontend' and 'datastore' (see lib/byolTopology.ts and
// client/pages/BYOLPage.tsx's `topology` prop). Velociraptor is a new app, so
// there is NO legacy indexerCount/searchHeadCount pair to fall back to: counts
// are read straight off `tiers`, validated per-tier, and always emitted back as
// `nodeTiers` (the shape lib/db persists into the `node_tiers` JSONB column).
//   • tiers['frontend']  → Velociraptor server nodes (velociraptor-server)
//   • tiers['datastore'] → MinIO datastore nodes     (datastore)
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** Velociraptor's two BYOL node tiers, in persisted/display order. */
const TIER_KEYS = ['frontend', 'datastore'] as const
type TierKey = (typeof TIER_KEYS)[number]

/** Error-message labels — must match client/pages/BYOLPage.tsx's `topology.tiers[].label`. */
const TIER_LABELS: Record<TierKey, string> = {
  frontend: 'Frontend nodes',
  datastore: 'Datastore nodes (MinIO)',
}

/** Distributed-deployment minimums per tier. */
const TIER_MINIMUMS: Record<TierKey, number> = {
  frontend: 1,
  datastore: 1,
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
 * uniformly fall back per-key to the tier's default minimum.
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

  // Generic per-tier node counts + placement (the SDK form's `tiers` array,
  // keyed to this app's declared topology — see client/pages/BYOLPage.tsx). A
  // tier the form omits falls back to its declared minimum.
  const tiers = parseTiers(body)
  const frontendTier = tiers.get('frontend')
  const datastoreTier = tiers.get('datastore')

  const frontendCount = frontendTier ? frontendTier.count : TIER_MINIMUMS.frontend
  const datastoreCount = datastoreTier ? datastoreTier.count : TIER_MINIMUMS.datastore
  if (frontendCount < TIER_MINIMUMS.frontend) {
    return { data: {}, error: `${TIER_LABELS.frontend} must be at least ${TIER_MINIMUMS.frontend}` }
  }
  if (datastoreCount < TIER_MINIMUMS.datastore) {
    return { data: {}, error: `${TIER_LABELS.datastore} must be at least ${TIER_MINIMUMS.datastore}` }
  }

  // "Distributed" is the multi-node stack — Velociraptor frontends behind a load
  // balancer over a shared MinIO datastore (single instance is the all-in-one
  // box). Each tier defaults to one node, so distributed carries no larger
  // minimum than the base ≥1 rule.
  const isDistributed = deploymentType === 'distributed'

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const frontendPlacement = isDistributed ? frontendTier?.placement ?? null : null
  const datastorePlacement = isDistributed ? datastoreTier?.placement ?? null : null
  if (isDistributed) {
    const frontendErr = validatePlacement(frontendPlacement, frontendCount)
    if (frontendErr) return { data: {}, error: `${TIER_LABELS.frontend} placement: ${frontendErr}` }
    const datastoreErr = validatePlacement(datastorePlacement, datastoreCount)
    if (datastoreErr) return { data: {}, error: `${TIER_LABELS.datastore} placement: ${datastoreErr}` }
    // Multi-region (region granularity) provisions per-region satellite VPCs peered
    // back to the main region — which requires a dedicated (BYOC) cloud fabric the
    // module owns (a hosted/shared network is a single looked-up VPC). Require it.
    const networkModeRaw = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
    for (const [label, p] of [
      [TIER_LABELS.frontend, frontendPlacement],
      [TIER_LABELS.datastore, datastorePlacement],
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
  // in display order [frontend, datastore]. This app persists ONLY this — there
  // are no legacy indexer/search-head scalar columns.
  const nodeTiers: NodeTierInput[] = [
    { key: 'frontend', count: frontendCount, placement: frontendPlacement },
    { key: 'datastore', count: datastoreCount, placement: datastorePlacement },
  ]

  const data: Record<string, unknown> = {
    name,
    deploymentType,
    environmentType,
    hosting_type: hostingType,
    region,
    networkMode,
    dnsMode,
    controlPlaneLayout,
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
