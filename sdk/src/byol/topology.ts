// =============================================================================
// BYOL resource-plan topology (pure, React-free).
//
// Given the shape of a BYOL infrastructure (deployment type, node counts,
// provider, regions), this derives the FULL set of resources needed to stand up
// and run an end-to-end Splunk environment — grouped into tiers, in provisioning
// order. It is the single source of truth for "what gets deployed":
//
//   • the app SERVER imports it (via the React-free root SDK entry) to SEED
//     `splunk_byol_resource` rows when a deployment is requested, and
//   • the app CLIENT renders it as the derived plan BEFORE the first deploy,
//     then swaps to the persisted rows once they exist.
//
// Keeping it here (and re-exported from the root entry) is what keeps both sides
// DRY without the app duplicating the topology rules.
// =============================================================================

/** Coarse grouping used to lay the plan out by tier in the UI and DB. */
export type ByolResourceTier = 'foundation' | 'control-plane' | 'data' | 'search' | 'ingest'

/** Lifecycle state of a single planned/provisioned resource. */
export type ByolResourceStatus = 'not_started' | 'provisioning' | 'ready' | 'attention' | 'failed'

/** A stable machine kind for a resource, used for icons + worker correlation. */
export type ByolResourceKind =
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'storage'
  | 'secrets'
  | 'license-file'
  | 'license-manager'
  | 'cluster-manager'
  | 'sh-deployer'
  | 'deployment-server'
  | 'monitoring-console'
  | 'indexer'
  | 'search-head'
  | 'hec'
  | 'heavy-forwarder'
  | 'standalone'

/** One resource in the plan. `planKey` is a stable identity for idempotent seeding. */
export interface ByolResourcePlanItem {
  planKey: string
  tier: ByolResourceTier
  kind: ByolResourceKind
  name: string
  role: string
  region: string | null
}

export interface ByolTopologyInput {
  deploymentType?: string
  indexerCount?: number
  searchHeadCount?: number
  /** Display provider name, e.g. "AWS" or "Self-Hosted". */
  hostingType?: string
  /** Whether the deployment targets a cloud provider (vs Self-Hosted). */
  isCloud?: boolean
  /** Primary region + any per-node regions, in preference order. */
  region?: string | null
  indexerRegions?: string[]
  searchHeadRegions?: string[]
}

export const TIER_LABELS: Record<ByolResourceTier, string> = {
  foundation: 'Foundation',
  'control-plane': 'Control plane',
  data: 'Data tier — indexer cluster',
  search: 'Search tier — search head cluster',
  ingest: 'Ingest & access',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'control-plane', 'data', 'search', 'ingest']

const DISTRIBUTED = 'distributed'

/** Pick a region for a node: its own region list, else the primary, else null. */
function pickRegion(regions: string[] | undefined, index: number, fallback: string | null): string | null {
  if (regions && regions.length > 0) return regions[index % regions.length]
  return fallback
}

/**
 * Build the ordered resource plan for a BYOL infrastructure.
 *
 * A single-instance deployment collapses to an all-in-one Splunk node plus the
 * foundation. A distributed deployment expands to the full topology: control
 * plane (license/cluster managers, deployment server, monitoring console, SH
 * deployer), an N-peer indexer cluster, an M-member search-head cluster, and the
 * ingest path (HEC + heavy forwarders).
 */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ----------------------------------------------------------
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'Search + HEC ingress', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'Web + inter-node (S2S)', region: null })
  items.push({ planKey: 'foundation/storage', tier: 'foundation', kind: 'storage', name: 'Storage', role: distributed ? 'SmartStore + hot/warm volumes' : 'Index volumes', region: primaryRegion })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · pass4SymmKey', region: null })
  items.push({ planKey: 'foundation/license-file', tier: 'foundation', kind: 'license-file', name: 'BYOL license file', role: 'Uploaded & validated', region: null })

  if (!distributed) {
    // --- Single instance: all-in-one node --------------------------------
    items.push({ planKey: 'data/standalone', tier: 'data', kind: 'standalone', name: 'Splunk instance', role: 'All-in-one (indexer + search head + web)', region: primaryRegion })
    items.push({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector', role: 'Token endpoint', region: primaryRegion })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Control plane -------------------------------------------------------
  items.push({ planKey: 'control-plane/license-manager', tier: 'control-plane', kind: 'license-manager', name: 'License Manager', role: 'Serves BYOL license pool', region: primaryRegion })
  items.push({ planKey: 'control-plane/cluster-manager', tier: 'control-plane', kind: 'cluster-manager', name: 'Cluster Manager', role: 'Indexer cluster coordinator', region: primaryRegion })
  items.push({ planKey: 'control-plane/sh-deployer', tier: 'control-plane', kind: 'sh-deployer', name: 'SH Deployer', role: 'Search head cluster deployer', region: primaryRegion })
  items.push({ planKey: 'control-plane/deployment-server', tier: 'control-plane', kind: 'deployment-server', name: 'Deployment Server', role: 'Forwarder app distribution', region: primaryRegion })
  items.push({ planKey: 'control-plane/monitoring-console', tier: 'control-plane', kind: 'monitoring-console', name: 'Monitoring Console', role: 'Fleet health & DMC', region: primaryRegion })

  // --- Data tier: indexer cluster -----------------------------------------
  const indexerCount = Math.max(1, input.indexerCount ?? 1)
  for (let i = 0; i < indexerCount; i++) {
    items.push({
      planKey: `data/indexer-${i + 1}`,
      tier: 'data',
      kind: 'indexer',
      name: `Indexer peer ${i + 1}`,
      role: 'Cluster peer node',
      region: pickRegion(input.indexerRegions, i, primaryRegion),
    })
  }

  // --- Search tier: search head cluster -----------------------------------
  const searchHeadCount = Math.max(1, input.searchHeadCount ?? 1)
  for (let i = 0; i < searchHeadCount; i++) {
    items.push({
      planKey: `search/search-head-${i + 1}`,
      tier: 'search',
      kind: 'search-head',
      name: `Search head ${i + 1}`,
      role: i === 0 ? 'SHC captain candidate' : 'SHC member',
      region: pickRegion(input.searchHeadRegions, i, primaryRegion),
    })
  }

  // --- Ingest & access -----------------------------------------------------
  items.push({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector', role: 'Token endpoint via LB', region: primaryRegion })
  items.push({ planKey: 'ingest/heavy-forwarder-1', tier: 'ingest', kind: 'heavy-forwarder', name: 'Heavy Forwarder 1', role: 'Ingest routing / props', region: primaryRegion })
  items.push({ planKey: 'ingest/heavy-forwarder-2', tier: 'ingest', kind: 'heavy-forwarder', name: 'Heavy Forwarder 2', role: 'Ingest routing / props', region: pickRegion(input.indexerRegions, 1, primaryRegion) })

  return items.map((it, i) => stampOrder(it, i))
}

/** Attach the plan's stable sort order (kept separate so callers can persist it). */
function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/**
 * The ordered high-level steps a deployment run advances through. Mirrors the
 * tier order plus the post-deploy phases. Workers report progress against these.
 */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS, storage and secrets.' },
  { key: 'license', title: 'License Manager online · license applied', detail: 'BYOL license validated and pool published.' },
  { key: 'cluster', title: 'Cluster Manager online', detail: 'Indexer cluster policy (RF/SF) published.' },
  { key: 'indexers', title: 'Indexer peers joining cluster', detail: 'Indexer peers boot and register with the cluster manager.' },
  { key: 'search-heads', title: 'Search head cluster forming', detail: 'Deployer pushes the SHC bundle; captain election.' },
  { key: 'services', title: 'Deployment server & monitoring console', detail: 'Ancillary control-plane services come online.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Apply indexes, HEC tokens and Splunk apps.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify search, ingest and replication end to end.' },
]
