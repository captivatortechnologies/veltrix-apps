// =============================================================================
// BYOL resource-plan topology for the Graylog stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end Graylog stack, grouped into tiers in provisioning order. The app
// SERVER uses it to seed `graylog_byol_resource` rows on deploy.
//
// Graylog is an open-source SIEM / log-management platform: a JVM GRAYLOG server
// exposing a web UI + REST API, backed by a distributed OPENSEARCH /
// Elasticsearch search engine and a single MONGODB metadata store. It is modeled
// as two USER-SCALABLE node tiers plus the fixed supporting infra:
//   • graylog     Graylog server — web UI + REST API   [app tier, ALB target]
//   • opensearch  OpenSearch / Elasticsearch nodes      [data tier]
//   • mongodb     MongoDB metadata / config store        [data tier, single]
//   • standalone  all-in-one single box (every role)     [app tier]
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexerCount/searchHeadCount
// fields. Only the two scalable tiers accept multi-site placement; MongoDB is a
// single instance in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Graylog-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the Graylog stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current Graylog
// deployment guidance (docs.graylog.org → architecture) before treating these
// roles/ports as production-grade. A distributed OpenSearch / Elasticsearch
// search tier should run ≥3 nodes for a real cluster (enforced in
// lib/byolInput.ts).
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
  // --- Graylog node roles ---
  | 'graylog'
  | 'opensearch'
  | 'mongodb'
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
   * read by key — 'graylog' / 'opensearch'. Absent tiers fall back to a count
   * of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for Graylog. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; Graylog has no forwarder tier. */
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
  data: 'Data tier — OpenSearch & MongoDB',
  app: 'Application tier — Graylog nodes',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL Graylog stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // Graylog is open source (no BYOL license file) and needs no object store, so
  // the foundation is network, optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'Graylog web + REST ingress (HTTP 9000)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'Graylog web/REST (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · password secret · MongoDB credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'Graylog node',
      role: 'All-in-one (Graylog server + OpenSearch + MongoDB)',
      region: primaryRegion,
      roles: ['graylog', 'opensearch', 'mongodb'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: OpenSearch / Elasticsearch search cluster + MongoDB ---
  const searchNodes = tierCount(input.tiers, 'opensearch')
  const searchSites = assignNodeSites(searchNodes, tierPlacement(input.tiers, 'opensearch'), primaryRegion)
  for (let i = 0; i < searchNodes; i++) {
    items.push({
      planKey: `data/opensearch-${i + 1}`,
      tier: 'data',
      kind: 'opensearch',
      name: searchNodes > 1 ? `OpenSearch node ${i + 1}` : 'OpenSearch node',
      role: i === 0 ? 'OpenSearch / Elasticsearch (primary)' : 'OpenSearch / Elasticsearch (data)',
      region: searchSites[i].region,
      zone: searchSites[i].zone,
      roles: ['opensearch'],
    })
  }

  // Fixed supporting service — single MongoDB in the main region (not user-scaled).
  items.push({ planKey: 'data/mongodb', tier: 'data', kind: 'mongodb', name: 'MongoDB', role: 'Metadata / configuration store', region: primaryRegion, roles: ['mongodb'] })

  // --- Application tier: Graylog server cluster (web + REST) ---
  // The ALB target(s).
  const graylogNodes = tierCount(input.tiers, 'graylog')
  const graylogSites = assignNodeSites(graylogNodes, tierPlacement(input.tiers, 'graylog'), primaryRegion)
  for (let i = 0; i < graylogNodes; i++) {
    items.push({
      planKey: `app/graylog-${i + 1}`,
      tier: 'app',
      kind: 'graylog',
      name: graylogNodes > 1 ? `Graylog ${i + 1}` : 'Graylog',
      role: i === 0 ? 'Graylog server — web UI + REST API (primary)' : 'Graylog server — web UI + REST API',
      region: graylogSites[i].region,
      zone: graylogSites[i].zone,
      roles: ['graylog', 'web', 'rest'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'data', title: 'Data services online', detail: 'OpenSearch / Elasticsearch and MongoDB boot and accept connections.' },
  { key: 'graylog', title: 'Graylog nodes booting', detail: 'The Graylog server nodes start and connect to OpenSearch and MongoDB.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Graylog init / index sets, streams, inputs and pipeline rules.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the Graylog web UI + REST API (9000) end to end.' },
]
