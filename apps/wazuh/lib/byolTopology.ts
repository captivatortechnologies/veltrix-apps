// =============================================================================
// BYOL resource-plan topology for the Wazuh cluster (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, node counts, provider, regions)
// this derives the FULL set of resources needed to stand up an end-to-end Wazuh
// cluster, grouped into tiers in provisioning order. The app SERVER uses it to
// seed `wazuh_byol_resource` rows on deploy.
//
// A Wazuh cluster is modelled as: a MANAGER control plane (a single indivisible
// manager master — analysisd/remoted/API/cluster — plus horizontally-scaled
// manager workers), a DATA tier of Wazuh indexer (OpenSearch) nodes, and a
// DASHBOARD tier (OpenSearch Dashboards — the analyst web UI, and the ALB
// target). The three shared BYOL node knobs are mapped as:
//   • indexerCount        → Wazuh indexer (OpenSearch) nodes   [data tier]
//   • searchHeadCount     → Wazuh manager worker nodes         [control-plane]
//   • heavyForwarderCount → Wazuh dashboard nodes              [dashboard tier]
// so the app reuses the SDK's Splunk-shaped form (Indexers / Search heads /
// Heavy forwarders) without a bespoke node-role editor.
//
// ⚠ CLUSTER SIZING IS A REASONABLE DEFAULT — VERIFY against current Wazuh
// deployment guidance (documentation.wazuh.com → "Installation" / "Wazuh
// cluster") before treating these node ratios as production-grade.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Wazuh-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.6.0). The SDK's client `byol` module keeps a Splunk-shaped copy for the
// browser Plan modal; here the SERVER owns the Wazuh cluster mapping.
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'control-plane' | 'data' | 'dashboard'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- Wazuh node roles ---
  | 'manager-master'
  | 'manager-worker'
  | 'indexer'
  | 'dashboard'
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
  /** Wazuh indexer (OpenSearch) nodes in the data tier. */
  indexerCount?: number
  /** Wazuh manager worker nodes in the control plane. */
  searchHeadCount?: number
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  indexerRegions?: string[]
  searchHeadRegions?: string[]
  /**
   * Control-plane consolidation layout (distributed only). Accepted for
   * shared-form compatibility; a Wazuh manager master is a single indivisible
   * node, so no management-role consolidation is applied.
   */
  controlPlaneLayout?: ControlPlaneLayout
  /** Wazuh dashboard node count (distributed only). Defaults to 1. */
  heavyForwarderCount?: number
  /** Multi-site placement of the indexer (data) cluster. */
  indexerPlacement?: ClusterPlacement | null
  /** Multi-site placement of the manager-worker (control-plane) tier. */
  searchHeadPlacement?: ClusterPlacement | null
}

interface NodeSite {
  region: string | null
  zone: string | null
}

/**
 * Resolve the per-node region/zone for a cluster tier. Multi-site placement
 * (indexer / manager-worker tiers only) spreads nodes across sites by percent.
 * Falls back to the legacy per-node region round-robin otherwise. Mirrors the
 * Security Onion / Splunk topology.
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
  'control-plane': 'Control plane — Wazuh managers',
  data: 'Data tier — Wazuh indexer (OpenSearch)',
  dashboard: 'Dashboard — analyst web UI',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'control-plane', 'data', 'dashboard']

const DISTRIBUTED = 'distributed'

function pickRegion(regions: string[] | undefined, index: number, fallback: string | null): string | null {
  if (regions && regions.length > 0) return regions[index % regions.length]
  return fallback
}

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL Wazuh cluster. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // No object storage (indexer data lives on the indexer nodes' volumes) and no
  // BYOL license file (Wazuh is open source) — so the foundation is lean:
  // network, optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'Wazuh dashboard ingress (HTTPS 443)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'Dashboard (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · cluster key · indexer credentials', region: null })

  if (!distributed) {
    items.push({ planKey: 'control-plane/standalone', tier: 'control-plane', kind: 'standalone', name: 'Wazuh node', role: 'All-in-one (manager + indexer + dashboard)', region: primaryRegion, roles: ['manager-master', 'indexer', 'dashboard'] })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Control plane: Wazuh managers ---
  // The manager master is a single indivisible node (analysisd · remoted · API ·
  // cluster daemon), always in the main region. Manager workers scale agent
  // capacity horizontally and may spread across sites.
  items.push({
    planKey: 'control-plane/manager-master',
    tier: 'control-plane',
    kind: 'manager-master',
    name: 'Manager master',
    role: 'Wazuh manager master (analysisd · remoted · API · cluster)',
    region: primaryRegion,
    roles: ['manager-master'],
  })
  const workerCount = Math.max(1, input.searchHeadCount ?? 1)
  const workerSites = assignNodeSites(workerCount, input.searchHeadPlacement, primaryRegion, input.searchHeadRegions)
  for (let i = 0; i < workerCount; i++) {
    items.push({
      planKey: `control-plane/manager-worker-${i + 1}`,
      tier: 'control-plane',
      kind: 'manager-worker',
      name: `Manager worker ${i + 1}`,
      role: 'Wazuh manager worker (agent-capacity scale)',
      region: workerSites[i].region,
      zone: workerSites[i].zone,
      roles: ['manager-worker'],
    })
  }

  // --- Data tier: Wazuh indexer (OpenSearch) cluster ---
  const indexerCount = Math.max(1, input.indexerCount ?? 1)
  const indexerSites = assignNodeSites(indexerCount, input.indexerPlacement, primaryRegion, input.indexerRegions)
  for (let i = 0; i < indexerCount; i++) {
    items.push({
      planKey: `data/indexer-${i + 1}`,
      tier: 'data',
      kind: 'indexer',
      name: `Indexer ${i + 1}`,
      role: i === 0 ? 'Wazuh indexer (OpenSearch) — primary' : 'Wazuh indexer (OpenSearch) node',
      region: indexerSites[i].region,
      zone: indexerSites[i].zone,
    })
  }

  // --- Dashboard tier: OpenSearch Dashboards (the ALB target) ---
  // Always main-region behind the load balancer. Defaults to a single dashboard;
  // scale out for HA on demand.
  const dashboardCount = Math.max(1, input.heavyForwarderCount ?? 1)
  for (let i = 0; i < dashboardCount; i++) {
    items.push({
      planKey: `dashboard/dashboard-${i + 1}`,
      tier: 'dashboard',
      kind: 'dashboard',
      name: dashboardCount > 1 ? `Dashboard ${i + 1}` : 'Dashboard',
      role: 'Wazuh dashboard (OpenSearch Dashboards) — analyst UI',
      region: primaryRegion,
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from cluster topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'manager-master', title: 'Manager master online · cluster ready', detail: 'The Wazuh manager master boots and the cluster daemon publishes cluster state.' },
  { key: 'manager-workers', title: 'Manager workers joining cluster', detail: 'Worker managers boot and register with the master over the cluster daemon (1516).' },
  { key: 'indexers', title: 'Indexer cluster forming', detail: 'Wazuh indexer (OpenSearch) nodes boot and form the cluster.' },
  { key: 'dashboard', title: 'Dashboard online', detail: 'The Wazuh dashboard comes online behind the load balancer (443).' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Apply custom rules, decoders, CDB lists, agent groups and index templates.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify agent enrollment, event ingest, indexing and dashboard end to end.' },
]
