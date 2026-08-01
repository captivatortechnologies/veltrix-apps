// =============================================================================
// BYOL resource-plan topology for the TheHive 5 stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end TheHive stack, grouped into tiers in provisioning order. The app
// SERVER uses it to seed `thehive_byol_resource` rows on deploy.
//
// TheHive 5 (StrangeBee) is a Security Incident Response Platform / SOAR whose
// runtime is a Scala/Play web+API APPLICATION backed by two distributed data
// stores — Apache Cassandra (the primary case/observable store) and
// Elasticsearch (the search index) — plus an S3-compatible object store
// (MinIO / S3) for file attachments. It is modeled as three USER-SCALABLE node
// tiers plus the fixed supporting object store:
//   • application  TheHive web/API application            [app tier, ALB target]
//   • cassandra    Apache Cassandra data store            [data tier]
//   • index        Elasticsearch search index             [data tier]
//   • minio        S3-compatible object / file store      [data tier, single]
//   • standalone   all-in-one single box (every role)     [app tier]
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexerCount/searchHeadCount
// fields. Only the three scalable tiers accept multi-site placement; the fixed
// object store is a single instance in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is TheHive-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the TheHive stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current TheHive 5
// deployment guidance (docs.strangebee.com → operations) before treating these
// roles/ports as production-grade. A real HA Cassandra ring and Elasticsearch
// cluster should each run ≥3 nodes for quorum (enforced in lib/byolInput.ts for
// distributed deployments).
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'data' | 'app'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- TheHive node roles ---
  | 'thehive'
  | 'cassandra'
  | 'index'
  | 'minio'
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
  /** Machine-readable roles this instance runs — drives post-deploy bring-up. */
  roles?: string[]
}

/** One entry of the generic `node_tiers` array — the SDK's `ByolTierValue` shape. */
export interface TopologyTier {
  key: string
  count: number
  placement?: ClusterPlacement | null
}

export interface ByolTopologyInput {
  deploymentType?: string
  /**
   * Generic per-tier node counts + placement (node_tiers-native). Counts are
   * read by key — 'application' / 'cassandra' / 'index'. Absent tiers fall back
   * to a count of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for TheHive. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; TheHive has no forwarder tier. */
  heavyForwarderCount?: number
}

interface NodeSite {
  region: string | null
  zone: string | null
}

/** Read a tier's node count by key from the generic tiers array (min 1). */
export function tierCount(tiers: TopologyTier[] | undefined, key: string): number {
  const t = tiers?.find((x) => x.key === key)
  return Math.max(1, Math.floor(t?.count ?? 1))
}

/** Read a tier's placement by key from the generic tiers array (null when absent). */
function tierPlacement(tiers: TopologyTier[] | undefined, key: string): ClusterPlacement | null {
  return tiers?.find((x) => x.key === key)?.placement ?? null
}

/**
 * Resolve the per-node region/zone for a scalable tier. Multi-site placement
 * spreads nodes across sites by percent; otherwise every node sits in the main
 * region.
 */
function assignNodeSites(
  count: number,
  placement: ClusterPlacement | null | undefined,
  primaryRegion: string | null,
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
  for (let i = 0; i < count; i++) out.push({ region: primaryRegion, zone: null })
  return out
}

/** Human labels per tier. */
export const TIER_LABELS: Record<ByolResourceTier, string> = {
  foundation: 'Foundation',
  data: 'Data tier — Cassandra, Elasticsearch & object storage',
  app: 'Application tier — TheHive',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL TheHive stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // TheHive is open source (no BYOL license file); object storage is modeled as
  // a data-tier `minio` service below, so the foundation is network, optional
  // LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'TheHive web/API ingress (HTTP 9000)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'TheHive web/API (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'TheHive secret · Cassandra/Elasticsearch/MinIO credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'TheHive node',
      role: 'All-in-one (TheHive + Cassandra + Elasticsearch + MinIO)',
      region: primaryRegion,
      roles: ['thehive', 'cassandra', 'index', 'minio'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: Cassandra ring + Elasticsearch index + object store ---
  const cassandraNodes = tierCount(input.tiers, 'cassandra')
  const cassandraSites = assignNodeSites(cassandraNodes, tierPlacement(input.tiers, 'cassandra'), primaryRegion)
  for (let i = 0; i < cassandraNodes; i++) {
    items.push({
      planKey: `data/cassandra-${i + 1}`,
      tier: 'data',
      kind: 'cassandra',
      name: cassandraNodes > 1 ? `Cassandra node ${i + 1}` : 'Cassandra node',
      role: i === 0 ? 'Apache Cassandra (primary / seed)' : 'Apache Cassandra (data)',
      region: cassandraSites[i].region,
      zone: cassandraSites[i].zone,
      roles: ['cassandra'],
    })
  }

  const indexNodes = tierCount(input.tiers, 'index')
  const indexSites = assignNodeSites(indexNodes, tierPlacement(input.tiers, 'index'), primaryRegion)
  for (let i = 0; i < indexNodes; i++) {
    items.push({
      planKey: `data/index-${i + 1}`,
      tier: 'data',
      kind: 'index',
      name: indexNodes > 1 ? `Elasticsearch node ${i + 1}` : 'Elasticsearch node',
      role: i === 0 ? 'Elasticsearch (primary)' : 'Elasticsearch (data)',
      region: indexSites[i].region,
      zone: indexSites[i].zone,
      roles: ['index'],
    })
  }

  // Fixed supporting service — a single object store in the main region (not user-scaled).
  items.push({ planKey: 'data/minio', tier: 'data', kind: 'minio', name: 'Object storage', role: 'S3-compatible file store (MinIO / S3)', region: primaryRegion })

  // --- Application tier: TheHive web/API cluster (the ALB target(s)) ---
  const appNodes = tierCount(input.tiers, 'application')
  const appSites = assignNodeSites(appNodes, tierPlacement(input.tiers, 'application'), primaryRegion)
  for (let i = 0; i < appNodes; i++) {
    items.push({
      planKey: `app/thehive-${i + 1}`,
      tier: 'app',
      kind: 'thehive',
      name: appNodes > 1 ? `TheHive ${i + 1}` : 'TheHive',
      role: i === 0 ? 'TheHive web/API application (primary)' : 'TheHive web/API application',
      region: appSites[i].region,
      zone: appSites[i].zone,
      roles: ['thehive'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'data', title: 'Data services online', detail: 'Cassandra, Elasticsearch and object storage boot and accept connections.' },
  { key: 'thehive', title: 'TheHive booting', detail: 'The TheHive web/API application starts and connects to Cassandra, Elasticsearch and object storage.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Case templates, custom fields, observable types and users.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the TheHive web/API application (9000) end to end.' },
]
