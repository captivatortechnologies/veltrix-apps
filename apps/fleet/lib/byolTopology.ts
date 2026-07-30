// =============================================================================
// BYOL resource-plan topology for the Fleet stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, node counts, provider, regions)
// this derives the FULL set of resources needed to stand up an end-to-end Fleet
// stack, grouped into tiers in provisioning order. The app SERVER uses it to
// seed `fleet_byol_resource` rows on deploy.
//
// The Fleet stack is a single-node-ish deployment (unlike Security Onion's
// distributed grid): a Fleet server (the app/control tier + ALB target on 8080),
// a MySQL database and a Redis cache as its data/support tiers, or a `standalone`
// all-in-one node for the single-node topology. The three shared BYOL node knobs
// keep the SDK's Splunk-shaped form (Indexers / Search heads / Heavy forwarders)
// and are mapped as:
//   • indexerCount        → MySQL database nodes  (database)     [data tier]
//   • searchHeadCount     → Fleet servers         (fleet-server) [application tier]
//   • heavyForwarderCount → Redis nodes           (redis)        [cache tier]
// so the app reuses the SDK's node form without a bespoke node-role editor.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Fleet-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against. The SDK's
// client `byol` module keeps a Splunk-shaped copy for the browser Plan modal;
// here the SERVER owns the Fleet stack mapping.
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'data' | 'cache' | 'application'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- Fleet stack node roles ---
  | 'fleet-server'
  | 'database'
  | 'redis'
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
  /** Machine-readable roles this instance runs — reserved for future bring-up. */
  roles?: string[]
}

export interface ByolTopologyInput {
  deploymentType?: string
  /** MySQL database nodes in the data tier. */
  indexerCount?: number
  /** Fleet servers in the application tier. */
  searchHeadCount?: number
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  indexerRegions?: string[]
  searchHeadRegions?: string[]
  /**
   * Control-plane consolidation layout — carried for wiring compatibility with
   * the shared BYOL record; the Fleet stack has no management-role split, so it
   * is unused here.
   */
  controlPlaneLayout?: ControlPlaneLayout
  /** Redis node count (distributed only). Defaults to 1. */
  heavyForwarderCount?: number
  /** Multi-site placement of the MySQL database cluster (data tier only). */
  indexerPlacement?: ClusterPlacement | null
  /** Multi-site placement of the Fleet server pool (application tier only). */
  searchHeadPlacement?: ClusterPlacement | null
}

interface NodeSite {
  region: string | null
  zone: string | null
}

/**
 * Resolve the per-node region/zone for a cluster tier. Multi-site placement
 * (data/application tiers only) spreads nodes across sites by percent. Falls back
 * to the legacy per-node region round-robin otherwise.
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

/** Human labels per tier. */
export const TIER_LABELS: Record<ByolResourceTier, string> = {
  foundation: 'Foundation',
  data: 'Data tier — MySQL database',
  cache: 'Cache tier — Redis',
  application: 'Application tier — Fleet server',
}

/** Provisioning order the tiers deploy in (also the display order). The Fleet
 *  server comes up LAST — it depends on MySQL + Redis already being online. */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'cache', 'application']

const DISTRIBUTED = 'distributed'

function pickRegion(regions: string[] | undefined, index: number, fallback: string | null): string | null {
  if (regions && regions.length > 0) return regions[index % regions.length]
  return fallback
}

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL Fleet stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // No object storage (Fleet state lives in MySQL + Redis) and no BYOL license
  // file (Fleet is open source) — so the foundation is lean: network, optional
  // LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'Fleet console ingress (HTTPS 8080)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'Fleet server (8080) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · MySQL credentials · Fleet server keys', region: null })

  if (!distributed) {
    items.push({ planKey: 'application/standalone', tier: 'application', kind: 'standalone', name: 'Fleet node', role: 'All-in-one (Fleet server + MySQL + Redis)', region: primaryRegion })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: MySQL database cluster ---
  // Only this tier and the application tier accept multi-site placement.
  const dbNodeCount = Math.max(1, input.indexerCount ?? 1)
  const dbSites = assignNodeSites(dbNodeCount, input.indexerPlacement, primaryRegion, input.indexerRegions)
  for (let i = 0; i < dbNodeCount; i++) {
    items.push({
      planKey: `data/database-${i + 1}`,
      tier: 'data',
      kind: 'database',
      name: `Database ${i + 1}`,
      role: i === 0 ? 'MySQL primary (Fleet datastore)' : 'MySQL replica (Fleet datastore)',
      region: dbSites[i].region,
      zone: dbSites[i].zone,
    })
  }

  // --- Cache tier: Redis ---
  // Redis is always main-region (live-query results + cache), like the Fleet
  // server's supporting nodes; it does not accept multi-site placement.
  const redisNodeCount = Math.max(1, input.heavyForwarderCount ?? 1)
  for (let i = 0; i < redisNodeCount; i++) {
    items.push({
      planKey: `cache/redis-${i + 1}`,
      tier: 'cache',
      kind: 'redis',
      name: redisNodeCount === 1 ? 'Redis' : `Redis ${i + 1}`,
      role: i === 0 ? 'Live-query results + cache (primary)' : 'Live-query results + cache (replica)',
      region: primaryRegion,
    })
  }

  // --- Application tier: Fleet server(s) behind the ALB ---
  const serverCount = Math.max(1, input.searchHeadCount ?? 1)
  const serverSites = assignNodeSites(serverCount, input.searchHeadPlacement, primaryRegion, input.searchHeadRegions)
  for (let i = 0; i < serverCount; i++) {
    items.push({
      planKey: `application/fleet-server-${i + 1}`,
      tier: 'application',
      kind: 'fleet-server',
      name: `Fleet server ${i + 1}`,
      role: 'Fleet REST API + web UI (HTTPS 8080; ALB target)',
      region: serverSites[i].region,
      zone: serverSites[i].zone,
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from the Fleet stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'database', title: 'MySQL database online', detail: 'Provision the MySQL datastore and apply the Fleet schema migration.' },
  { key: 'cache', title: 'Redis online', detail: 'Provision Redis for live-query results and caching.' },
  { key: 'fleet-server', title: 'Fleet server online', detail: 'Fleet server boots, connects to MySQL + Redis and serves the REST API.' },
  { key: 'bringup', title: 'Fleet setup & configuration', detail: 'Run fleetctl bring-up: schema migration, server config and org settings.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the Fleet REST API, database and cache end to end (/healthz).' },
]
