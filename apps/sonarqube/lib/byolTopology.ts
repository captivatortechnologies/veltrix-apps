// =============================================================================
// BYOL resource-plan topology for the SonarQube stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end SonarQube stack, grouped into tiers in provisioning order. The app
// SERVER uses it to seed `sonarqube_byol_resource` rows on deploy.
//
// SonarQube (Data Center Edition topology) is a Java web/compute application
// fronted by a load balancer, an Elasticsearch SEARCH cluster, and an external
// PostgreSQL database. It is modeled as two USER-SCALABLE node tiers plus the
// fixed supporting infra:
//   • sonarqube-app  SonarQube web server + compute engine   [app tier, ALB target]
//   • search         Elasticsearch search nodes               [data tier]
//   • postgres       PostgreSQL database                      [data tier, single]
//   • standalone     all-in-one single box (web + compute + search)  [app tier]
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexer_count/search_head_count
// fields. Only the two scalable tiers accept multi-site placement; PostgreSQL is
// a single instance in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is SonarQube-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the SonarQube stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current SonarQube
// deployment guidance (docs.sonarsource.com → Data Center Edition) before
// treating these roles/ports as production-grade. A distributed Elasticsearch
// search tier should run ≥3 nodes for a real cluster (enforced in lib/byolInput.ts).
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
  // --- SonarQube node roles ---
  | 'sonarqube-app'
  | 'search'
  | 'postgres'
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
   * read by key — 'application' / 'search'. Absent tiers fall back to a count of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for SonarQube. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; SonarQube has no forwarder tier. */
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
  data: 'Data tier — Elasticsearch search & PostgreSQL',
  app: 'Application tier — SonarQube web & compute',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL SonarQube stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // SonarQube's licensed Data Center Edition needs no license FILE resource here
  // (the license is applied in-product post-deploy), so the foundation is network,
  // optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'SonarQube web + Web API ingress (HTTP 9000)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'SonarQube web (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin token · JDBC credentials · inter-node keys', region: null })

  // PostgreSQL — a single managed database in BOTH single and distributed stacks.
  const postgres: ByolResourcePlanItem = {
    planKey: 'data/postgres',
    tier: 'data',
    kind: 'postgres',
    name: 'PostgreSQL',
    role: 'SonarQube database (single)',
    region: primaryRegion,
    roles: ['postgres'],
  }

  if (!distributed) {
    // Single instance collapses the web/compute + embedded Elasticsearch onto one
    // all-in-one node, still backed by the single external PostgreSQL.
    items.push(postgres)
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'SonarQube node',
      role: 'All-in-one (web + compute engine + Elasticsearch search)',
      region: primaryRegion,
      roles: ['web', 'compute', 'search'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: Elasticsearch search cluster + PostgreSQL ---
  const searchNodes = tierCount(input.tiers, 'search')
  const searchSites = assignNodeSites(searchNodes, tierPlacement(input.tiers, 'search'), primaryRegion)
  for (let i = 0; i < searchNodes; i++) {
    items.push({
      planKey: `data/search-${i + 1}`,
      tier: 'data',
      kind: 'search',
      name: searchNodes > 1 ? `Search node ${i + 1}` : 'Search node',
      role: i === 0 ? 'Elasticsearch search (primary)' : 'Elasticsearch search (data)',
      region: searchSites[i].region,
      zone: searchSites[i].zone,
      roles: ['search'],
    })
  }
  items.push(postgres)

  // --- Application tier: SonarQube app cluster (web + compute engine) ---
  // The ALB target(s).
  const appNodes = tierCount(input.tiers, 'application')
  const appSites = assignNodeSites(appNodes, tierPlacement(input.tiers, 'application'), primaryRegion)
  for (let i = 0; i < appNodes; i++) {
    items.push({
      planKey: `app/sonarqube-app-${i + 1}`,
      tier: 'app',
      kind: 'sonarqube-app',
      name: appNodes > 1 ? `Application ${i + 1}` : 'Application',
      role: i === 0 ? 'SonarQube web + compute engine (primary)' : 'SonarQube web + compute engine',
      region: appSites[i].region,
      zone: appSites[i].zone,
      roles: ['web', 'compute'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'data', title: 'Data services online', detail: 'Elasticsearch search nodes and PostgreSQL boot and accept connections.' },
  { key: 'sonarqube-app', title: 'SonarQube starting', detail: 'The SonarQube web server + compute engine start and connect to Elasticsearch and PostgreSQL.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'SonarQube system settings, quality gates, profiles and permission templates.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the SonarQube web UI + Web API (9000) end to end.' },
]
