// =============================================================================
// BYOL resource-plan topology (app-owned, pure, dependency-free).
//
// Given a BYOL infrastructure (deployment type, node counts, provider, regions)
// this derives the FULL set of resources needed to stand up an end-to-end Splunk
// environment, grouped into tiers in provisioning order. The app SERVER uses it
// to seed `splunk_byol_resource` rows on deploy.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Splunk-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^2.5.0). The SDK's client `byol` module keeps its own copy for the
// browser (bundled into the client bundle). Keep the two in sync.
// =============================================================================

export type ByolResourceTier = 'foundation' | 'control-plane' | 'data' | 'search' | 'ingest'

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
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  indexerRegions?: string[]
  searchHeadRegions?: string[]
}

/** Human labels per tier (mirrors the SDK topology). */
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

function pickRegion(regions: string[] | undefined, index: number, fallback: string | null): string | null {
  if (regions && regions.length > 0) return regions[index % regions.length]
  return fallback
}

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL infrastructure. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
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
    items.push({ planKey: 'data/standalone', tier: 'data', kind: 'standalone', name: 'Splunk instance', role: 'All-in-one (indexer + search head + web)', region: primaryRegion })
    items.push({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector', role: 'Token endpoint', region: primaryRegion })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Control plane ---
  items.push({ planKey: 'control-plane/license-manager', tier: 'control-plane', kind: 'license-manager', name: 'License Manager', role: 'Serves BYOL license pool', region: primaryRegion })
  items.push({ planKey: 'control-plane/cluster-manager', tier: 'control-plane', kind: 'cluster-manager', name: 'Cluster Manager', role: 'Indexer cluster coordinator', region: primaryRegion })
  items.push({ planKey: 'control-plane/sh-deployer', tier: 'control-plane', kind: 'sh-deployer', name: 'SH Deployer', role: 'Search head cluster deployer', region: primaryRegion })
  items.push({ planKey: 'control-plane/deployment-server', tier: 'control-plane', kind: 'deployment-server', name: 'Deployment Server', role: 'Forwarder app distribution', region: primaryRegion })
  items.push({ planKey: 'control-plane/monitoring-console', tier: 'control-plane', kind: 'monitoring-console', name: 'Monitoring Console', role: 'Fleet health & DMC', region: primaryRegion })

  // --- Data tier: indexer cluster ---
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

  // --- Search tier: search head cluster ---
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

  // --- Ingest & access ---
  items.push({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector', role: 'Token endpoint via LB', region: primaryRegion })
  items.push({ planKey: 'ingest/heavy-forwarder-1', tier: 'ingest', kind: 'heavy-forwarder', name: 'Heavy Forwarder 1', role: 'Ingest routing / props', region: primaryRegion })
  items.push({ planKey: 'ingest/heavy-forwarder-2', tier: 'ingest', kind: 'heavy-forwarder', name: 'Heavy Forwarder 2', role: 'Ingest routing / props', region: pickRegion(input.indexerRegions, 1, primaryRegion) })

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
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
