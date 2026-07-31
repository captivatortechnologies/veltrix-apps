// =============================================================================
// BYOL infrastructure request validation (pure).
//
// Extracted from server/index.ts so the coercion/validation rules — including
// the topology-authoring fields (control-plane layout, sensor count, cluster
// placement) — can be unit tested without pulling in Fastify or the platform DB.
//
// The SDK's <ByolInfrastructureManager> now sends a generic `tiers: [{ key,
// count, placement }]` array (this app declares two — 'database' and 'core',
// see lib/byolTopology.ts and client/pages/BYOLPage.tsx's `topology` prop)
// instead of the old Splunk-shaped indexerCount/searchHeadCount/
// indexerPlacement/searchHeadPlacement fields. Those legacy fields are still
// ACCEPTED as a per-tier fallback (an older client, or a partial `tiers`
// array) and are always POPULATED on the way out via `nodeTiers`, so a
// legacy-shaped write still persists the generic column. MISP's two tiers map
// onto its stack roles (see lib/byolTopology.ts):
//   • tiers['database'] → MariaDB database nodes (indexerCount)
//   • tiers['core']     → MISP core web/API nodes (searchHeadCount)
//
// Region associations (indexerRegions / searchHeadRegions) are intentionally NOT
// written here.
// =============================================================================

import { normalizeControlPlaneLayout, parsePlacement, validatePlacement, type ClusterPlacement } from './byolPlacement'

/** MISP's two BYOL node tiers, in persisted/display order. */
const TIER_KEYS = ['database', 'core'] as const
type TierKey = (typeof TIER_KEYS)[number]

/** Error-message labels — must match client/pages/BYOLPage.tsx's `topology.tiers[].label`. */
const TIER_LABELS: Record<TierKey, string> = {
  database: 'Database nodes',
  core: 'MISP core nodes',
}

/** Distributed-deployment minimums per tier. MISP is usually single-node, so both stay permissive. */
const TIER_MINIMUMS: Record<TierKey, number> = {
  database: 1,
  core: 1,
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

  // Generic per-tier node counts + placement (the SDK form's `tiers` array,
  // keyed to this app's declared topology — see client/pages/BYOLPage.tsx).
  // Each tier falls back independently to the legacy top-level
  // indexerCount/searchHeadCount/*Placement fields, so an older client, or a
  // `tiers` array missing one key, still resolves a sensible value.
  const tiers = parseTiers(body)
  const databaseTier = tiers.get('database')
  const coreTier = tiers.get('core')

  const indexerCount = databaseTier ? databaseTier.count : toInt(body?.indexerCount, 1)
  const searchHeadCount = coreTier ? coreTier.count : toInt(body?.searchHeadCount, 1)
  if (indexerCount < TIER_MINIMUMS.database) {
    return { data: {}, error: `${TIER_LABELS.database} must be at least ${TIER_MINIMUMS.database}` }
  }
  if (searchHeadCount < TIER_MINIMUMS.core) {
    return { data: {}, error: `${TIER_LABELS.core} must be at least ${TIER_MINIMUMS.core}` }
  }

  // "Distributed" is the multi-node MISP stack — MISP core + MariaDB + Redis on
  // separate nodes (single instance is the all-in-one box). Each role defaults to
  // one node, so distributed carries no larger minimum than the base ≥1 rule.
  const isDistributed = deploymentType === 'distributed'

  // Topology authoring — only meaningful for distributed deployments. Single
  // instance / self-hosted collapse to defaults (dedicated, one sensor, single-site).
  const controlPlaneLayout = isDistributed ? normalizeControlPlaneLayout(body?.controlPlaneLayout) : 'dedicated'
  const heavyForwarderCount = isDistributed ? Math.max(1, toInt(body?.heavyForwarderCount, 1)) : 1
  const indexerPlacement = isDistributed
    ? databaseTier?.placement ?? parsePlacement(body?.indexerPlacement)
    : null
  const searchHeadPlacement = isDistributed
    ? coreTier?.placement ?? parsePlacement(body?.searchHeadPlacement)
    : null
  if (isDistributed) {
    const indexerErr = validatePlacement(indexerPlacement, indexerCount)
    if (indexerErr) return { data: {}, error: `${TIER_LABELS.database} placement: ${indexerErr}` }
    const searchErr = validatePlacement(searchHeadPlacement, searchHeadCount)
    if (searchErr) return { data: {}, error: `${TIER_LABELS.core} placement: ${searchErr}` }
    // Multi-region (region granularity) provisions per-region satellite VPCs peered
    // back to the main region — which requires a dedicated (BYOC) cloud fabric the
    // module owns (a hosted/shared network is a single looked-up VPC). Require it.
    const networkModeRaw = typeof body?.networkMode === 'string' ? body.networkMode.trim() : 'shared'
    for (const [label, p] of [
      [TIER_LABELS.database, indexerPlacement],
      [TIER_LABELS.core, searchHeadPlacement],
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
  // in display order [database, core] — populated regardless of which shape
  // the request body used, so a legacy-shaped write still persists `tiers`.
  const nodeTiers: NodeTierInput[] = [
    { key: 'database', count: indexerCount, placement: indexerPlacement },
    { key: 'core', count: searchHeadCount, placement: searchHeadPlacement },
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
