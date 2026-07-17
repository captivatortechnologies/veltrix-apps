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

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from './byolPlacement'

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
  // A single instance running several combined control-plane management roles.
  | 'management-node'

export interface ByolResourcePlanItem {
  planKey: string
  tier: ByolResourceTier
  kind: ByolResourceKind
  name: string
  role: string
  region: string | null
  /** Availability zone within `region` (multi-AZ placement); null otherwise. */
  zone?: string | null
  /** Machine-readable roles this instance runs — drives control-plane bring-up. */
  roles?: string[]
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
  /** Control-plane consolidation layout (distributed only). Defaults to 'dedicated'. */
  controlPlaneLayout?: ControlPlaneLayout
  /** Heavy forwarder count (distributed only). Defaults to 1. */
  heavyForwarderCount?: number
  /** Multi-site placement of the indexer cluster (indexer/search tiers only). */
  indexerPlacement?: ClusterPlacement | null
  /** Multi-site placement of the search-head cluster. */
  searchHeadPlacement?: ClusterPlacement | null
}

/** A control-plane management role that can be dedicated or combined onto a node. */
type ControlPlaneRole =
  | 'license-manager'
  | 'cluster-manager'
  | 'sh-deployer'
  | 'deployment-server'
  | 'monitoring-console'

const CONTROL_PLANE_ROLE_META: Record<ControlPlaneRole, { kind: ByolResourceKind; name: string; role: string }> = {
  'license-manager': { kind: 'license-manager', name: 'License Manager', role: 'Serves BYOL license pool' },
  'cluster-manager': { kind: 'cluster-manager', name: 'Cluster Manager', role: 'Indexer cluster coordinator' },
  'sh-deployer': { kind: 'sh-deployer', name: 'SH Deployer', role: 'Search head cluster deployer' },
  'deployment-server': { kind: 'deployment-server', name: 'Deployment Server', role: 'Forwarder app distribution' },
  'monitoring-console': { kind: 'monitoring-console', name: 'Monitoring Console', role: 'Fleet health & DMC' },
}

/**
 * Group the five management roles into instances per consolidation layout. The
 * cluster manager and SH deployer stay isolated when consolidating; only the
 * lighter roles combine. Mirrors the SDK topology.
 */
function controlPlaneGroups(layout: ControlPlaneLayout): ControlPlaneRole[][] {
  switch (layout) {
    case 'single':
      return [['license-manager', 'cluster-manager', 'sh-deployer', 'deployment-server', 'monitoring-console']]
    case 'consolidated':
      return [['cluster-manager'], ['sh-deployer'], ['license-manager', 'deployment-server', 'monitoring-console']]
    case 'dedicated':
    default:
      return [['license-manager'], ['cluster-manager'], ['sh-deployer'], ['deployment-server'], ['monitoring-console']]
  }
}

/** Build the control-plane instances for a layout (each running one or more roles). */
function buildControlPlane(layout: ControlPlaneLayout, region: string | null): ByolResourcePlanItem[] {
  return controlPlaneGroups(layout).map((roles) => {
    if (roles.length === 1) {
      const meta = CONTROL_PLANE_ROLE_META[roles[0]]
      return { planKey: `control-plane/${roles[0]}`, tier: 'control-plane', kind: meta.kind, name: meta.name, role: meta.role, region, roles: [roles[0]] }
    }
    const label = roles.map((r) => CONTROL_PLANE_ROLE_META[r].name).join(' · ')
    return {
      planKey: 'control-plane/management',
      tier: 'control-plane',
      kind: 'management-node',
      name: roles.length >= 5 ? 'Management node (all roles)' : 'Management node',
      role: label,
      region,
      roles: [...roles],
    }
  })
}

interface NodeSite {
  region: string | null
  zone: string | null
}

/**
 * Resolve the per-node region/zone for a cluster tier. Multi-site placement
 * (indexer/search only) spreads nodes across sites by percent. Falls back to the
 * legacy per-node region round-robin otherwise. Mirrors the SDK topology.
 */
function assignNodeSites(
  count: number,
  placement: ClusterPlacement | null | undefined,
  primaryRegion: string | null,
  legacyRegions: string[] | undefined,
): NodeSite[] {
  const eff = effectivePlacement(placement ?? undefined, true)
  if (eff.mode === 'multi-site' && eff.sites && eff.sites.length >= 2) {
    const granularity = eff.granularity ?? 'az'
    const out: NodeSite[] = []
    for (const alloc of allocateNodesBySite(count, eff.sites)) {
      for (let k = 0; k < alloc.count; k++) {
        out.push(granularity === 'az' ? { region: primaryRegion, zone: alloc.site } : { region: alloc.site, zone: null })
      }
    }
    return out
  }
  const out: NodeSite[] = []
  for (let i = 0; i < count; i++) out.push({ region: pickRegion(legacyRegions, i, primaryRegion), zone: null })
  return out
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
  // Always in the main region; consolidation only changes how many instances the
  // management roles run on.
  items.push(...buildControlPlane(input.controlPlaneLayout ?? 'dedicated', primaryRegion))

  // --- Data tier: indexer cluster ---
  // Only this tier and the search tier accept multi-site placement.
  const indexerCount = Math.max(1, input.indexerCount ?? 1)
  const indexerSites = assignNodeSites(indexerCount, input.indexerPlacement, primaryRegion, input.indexerRegions)
  for (let i = 0; i < indexerCount; i++) {
    items.push({
      planKey: `data/indexer-${i + 1}`,
      tier: 'data',
      kind: 'indexer',
      name: `Indexer peer ${i + 1}`,
      role: 'Cluster peer node',
      region: indexerSites[i].region,
      zone: indexerSites[i].zone,
    })
  }

  // --- Search tier: search head cluster ---
  const searchHeadCount = Math.max(1, input.searchHeadCount ?? 1)
  const searchHeadSites = assignNodeSites(searchHeadCount, input.searchHeadPlacement, primaryRegion, input.searchHeadRegions)
  for (let i = 0; i < searchHeadCount; i++) {
    items.push({
      planKey: `search/search-head-${i + 1}`,
      tier: 'search',
      kind: 'search-head',
      name: `Search head ${i + 1}`,
      role: i === 0 ? 'SHC captain candidate' : 'SHC member',
      region: searchHeadSites[i].region,
      zone: searchHeadSites[i].zone,
    })
  }

  // --- Ingest & access ---
  // Ingest is always main-region. Heavy forwarders default to 1; more on demand.
  items.push({ planKey: 'ingest/hec', tier: 'ingest', kind: 'hec', name: 'HTTP Event Collector', role: 'Token endpoint via LB', region: primaryRegion })
  const heavyForwarderCount = Math.max(1, input.heavyForwarderCount ?? 1)
  for (let i = 0; i < heavyForwarderCount; i++) {
    items.push({
      planKey: `ingest/heavy-forwarder-${i + 1}`,
      tier: 'ingest',
      kind: 'heavy-forwarder',
      name: `Heavy Forwarder ${i + 1}`,
      role: 'Ingest routing / props',
      region: primaryRegion,
    })
  }

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
