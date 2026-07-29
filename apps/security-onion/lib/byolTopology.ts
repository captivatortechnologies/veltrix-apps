// =============================================================================
// BYOL resource-plan topology for the Security Onion grid (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, node counts, provider, regions)
// this derives the FULL set of resources needed to stand up an end-to-end
// Security Onion grid, grouped into tiers in provisioning order. The app SERVER
// uses it to seed `so_byol_resource` rows on deploy.
//
// ⚠ GRID SIZING IS A REASONABLE DEFAULT — VERIFY against current Security Onion
// deployment guidance (docs.securityonion.net → "Architecture" / node types)
// before treating these node ratios as production-grade. The mapping models the
// distributed grid as: a manager control plane, an Elasticsearch data tier
// (search nodes), a heavy-node search/processing tier, and a sensor/forward/
// fleet ingest tier. The three shared BYOL node knobs are mapped as:
//   • indexerCount       → Elasticsearch data nodes (search-node)  [data tier]
//   • searchHeadCount    → heavy nodes               (heavy-node)  [search tier]
//   • heavyForwarderCount→ capture sensors           (sensor)      [ingest tier]
// so the app reuses the SDK's Splunk-shaped form (Indexers / Search heads /
// Heavy forwarders) without a bespoke node-role editor.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Security-Onion-
// specific, and the app must not depend on an SDK export that may be absent in
// whatever @veltrixsecops/app-sdk version the platform packages the app against
// (the app pins ^3.5.0). The SDK's client `byol` module keeps a Splunk-shaped
// copy for the browser Plan modal; here the SERVER owns the SO grid mapping.
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'control-plane' | 'data' | 'search' | 'ingest'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- Security Onion node roles ---
  | 'manager'
  | 'manager-search'
  | 'search-node'
  | 'sensor'
  | 'forward-node'
  | 'fleet-node'
  | 'receiver'
  | 'heavy-node'
  | 'idh'
  | 'standalone'

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
  /** Elasticsearch data nodes (search-node) in the data tier. */
  indexerCount?: number
  /** Heavy nodes (heavy-node) in the search tier. */
  searchHeadCount?: number
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  indexerRegions?: string[]
  searchHeadRegions?: string[]
  /** Control-plane consolidation layout (distributed only). Defaults to 'dedicated'. */
  controlPlaneLayout?: ControlPlaneLayout
  /** Capture sensor count (distributed only). Defaults to 1. */
  heavyForwarderCount?: number
  /** Multi-site placement of the search-node data cluster (data/search tiers only). */
  indexerPlacement?: ClusterPlacement | null
  /** Multi-site placement of the heavy-node search cluster. */
  searchHeadPlacement?: ClusterPlacement | null
}

/**
 * A Security Onion manager management service that can be dedicated to its own
 * instance or combined onto a manager node. Mirrors Splunk's control-plane role
 * consolidation, but every management role runs on a `manager` (or the compact
 * `manager-search`) box — Security Onion does not split these onto distinct kinds.
 */
type ManagerRole = 'salt-master' | 'soc-console' | 'fleet' | 'monitoring'

const MANAGER_ROLE_META: Record<ManagerRole, { name: string; role: string }> = {
  'salt-master': { name: 'Salt Master', role: 'Grid orchestration & config management' },
  'soc-console': { name: 'SOC Console', role: 'Analyst web console + Kibana' },
  fleet: { name: 'Fleet Server', role: 'Elastic Agent enrollment & management' },
  monitoring: { name: 'Monitoring', role: 'InfluxDB metrics + Grafana dashboards' },
}

/**
 * Group the manager management roles into instances per consolidation layout.
 * `single` folds every role onto one node, `dedicated` gives each its own —
 * fewer instances cut cost, more give isolation and HA. Mirrors the Splunk
 * topology's role grouping. Each group's first role keys its plan row.
 */
function managerGroups(layout: ControlPlaneLayout): ManagerRole[][] {
  switch (layout) {
    case 'single':
      return [['salt-master', 'soc-console', 'fleet', 'monitoring']]
    case 'consolidated':
      return [['salt-master', 'soc-console'], ['fleet', 'monitoring']]
    case 'dedicated':
    default:
      return [['salt-master'], ['soc-console'], ['fleet'], ['monitoring']]
  }
}

/** Build the control-plane manager instances for a layout (each running one or more roles). */
function buildControlPlane(layout: ControlPlaneLayout, region: string | null): ByolResourcePlanItem[] {
  return managerGroups(layout).map((roles, i) => {
    // A `single` layout collapses to one compact manager that ALSO carries the
    // search role (manager-search); otherwise search lives on dedicated search
    // nodes and the management box stays a plain `manager`.
    const kind: ByolResourceKind = i === 0 && layout === 'single' ? 'manager-search' : 'manager'
    if (roles.length === 1) {
      const meta = MANAGER_ROLE_META[roles[0]]
      return {
        planKey: `control-plane/${roles[0]}`,
        tier: 'control-plane',
        kind,
        name: meta.name,
        role: meta.role,
        region,
        roles: [roles[0]],
      }
    }
    const label = roles.map((r) => MANAGER_ROLE_META[r].name).join(' · ')
    return {
      planKey: `control-plane/${roles[0]}`,
      tier: 'control-plane',
      kind,
      name: roles.length >= 4 ? 'Manager node (all roles)' : 'Manager node',
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
 * (data/search tiers only) spreads nodes across sites by percent. Falls back to
 * the legacy per-node region round-robin otherwise. Mirrors the Splunk topology.
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
  'control-plane': 'Control plane — manager',
  data: 'Data tier — Elasticsearch search nodes',
  search: 'Search tier — heavy nodes',
  ingest: 'Ingest & sensors',
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

/** Build the ordered resource plan for a BYOL Security Onion grid. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // No object storage (PCAP stays local on sensors, ES data on node volumes) and
  // no BYOL license file (Security Onion is open source) — so the foundation is
  // leaner than Splunk's: network, optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'SOC console ingress (HTTPS 443)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'SOC console (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · Salt keys · ES credentials', region: null })

  if (!distributed) {
    items.push({ planKey: 'control-plane/standalone', tier: 'control-plane', kind: 'standalone', name: 'Security Onion node', role: 'All-in-one (manager + sensor + search + web)', region: primaryRegion })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Control plane ---
  // Always in the main region; consolidation only changes how many instances the
  // manager management roles run on.
  items.push(...buildControlPlane(input.controlPlaneLayout ?? 'dedicated', primaryRegion))

  // --- Data tier: Elasticsearch search-node cluster ---
  // Only this tier and the search tier accept multi-site placement.
  const dataNodeCount = Math.max(1, input.indexerCount ?? 1)
  const dataSites = assignNodeSites(dataNodeCount, input.indexerPlacement, primaryRegion, input.indexerRegions)
  for (let i = 0; i < dataNodeCount; i++) {
    items.push({
      planKey: `data/search-node-${i + 1}`,
      tier: 'data',
      kind: 'search-node',
      name: `Search node ${i + 1}`,
      role: i === 0 ? 'Elasticsearch data / search (primary)' : 'Elasticsearch data / search node',
      region: dataSites[i].region,
      zone: dataSites[i].zone,
    })
  }

  // --- Search tier: heavy-node cluster ---
  const heavyNodeCount = Math.max(1, input.searchHeadCount ?? 1)
  const heavySites = assignNodeSites(heavyNodeCount, input.searchHeadPlacement, primaryRegion, input.searchHeadRegions)
  for (let i = 0; i < heavyNodeCount; i++) {
    items.push({
      planKey: `search/heavy-node-${i + 1}`,
      tier: 'search',
      kind: 'heavy-node',
      name: `Heavy node ${i + 1}`,
      role: 'Self-contained sensor + search + storage',
      region: heavySites[i].region,
      zone: heavySites[i].zone,
    })
  }

  // --- Ingest & sensors ---
  // Ingest is always main-region. A Fleet data intake and a forward node are
  // always provisioned (analogous to Splunk's always-on HEC); capture sensors
  // default to 1 and scale on demand.
  items.push({ planKey: 'ingest/fleet', tier: 'ingest', kind: 'fleet-node', name: 'Fleet data ingest', role: 'Elastic Agent data intake (8220/5055)', region: primaryRegion })
  items.push({ planKey: 'ingest/forward-node', tier: 'ingest', kind: 'forward-node', name: 'Forward node', role: 'Sensor data aggregation / forwarding', region: primaryRegion })
  const sensorCount = Math.max(1, input.heavyForwarderCount ?? 1)
  for (let i = 0; i < sensorCount; i++) {
    items.push({
      planKey: `ingest/sensor-${i + 1}`,
      tier: 'ingest',
      kind: 'sensor',
      name: `Sensor ${i + 1}`,
      role: 'NIDS capture (Suricata · Zeek · Stenographer)',
      region: primaryRegion,
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from grid topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'manager', title: 'Manager online · Salt master ready', detail: 'Grid manager boots; the Salt master publishes grid state.' },
  { key: 'search-nodes', title: 'Search nodes joining grid', detail: 'Elasticsearch data nodes boot and register with the manager.' },
  { key: 'heavy-nodes', title: 'Heavy nodes forming', detail: 'Heavy nodes come online with their own sensor + search stack.' },
  { key: 'sensors', title: 'Sensors & forward nodes registering', detail: 'Sensors enroll via Salt and begin capture; forward nodes route traffic.' },
  { key: 'fleet', title: 'Fleet & Elastic Agent enrollment', detail: 'Fleet server online; Elastic Agents enroll and stream data.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Apply detections, Suricata/Zeek rules and Elasticsearch ILM.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify capture, ingest and search end to end.' },
]
