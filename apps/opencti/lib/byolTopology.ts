// =============================================================================
// BYOL resource-plan topology for the OpenCTI stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end OpenCTI stack, grouped into tiers in provisioning order. The app
// SERVER uses it to seed `opencti_byol_resource` rows on deploy.
//
// OpenCTI is a multi-service cyber threat-intel platform: a Node.js GraphQL/web
// PLATFORM, a pool of ingest WORKERS, a distributed SEARCH engine
// (Elasticsearch / OpenSearch), plus three fixed supporting services — Redis
// (cache / session / stream), RabbitMQ (the worker message broker) and an
// S3-compatible object store (MinIO / S3) for the file store. It is modeled as
// three USER-SCALABLE node tiers plus the fixed supporting infra:
//   • opencti-platform  OpenCTI GraphQL API + web UI      [app tier, ALB target]
//   • worker            ingest / enrichment workers        [ingest tier]
//   • search            Elasticsearch / OpenSearch nodes   [data tier]
//   • redis             cache / session / stream broker     [data tier, single]
//   • rabbitmq          worker message broker (AMQP)        [data tier, single]
//   • minio             S3-compatible object / file store   [data tier, single]
//   • standalone        all-in-one single box (every role)  [app tier]
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexerCount/searchHeadCount
// fields. Only the three scalable tiers accept multi-site placement; the fixed
// supporting services are single instances in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is OpenCTI-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the OpenCTI stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current OpenCTI
// deployment guidance (docs.opencti.io → deployment) before treating these
// roles/ports as production-grade. A distributed Elasticsearch/OpenSearch search
// tier should run ≥3 nodes for a real cluster (enforced in lib/byolInput.ts).
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'data' | 'app' | 'ingest'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- OpenCTI node roles ---
  | 'opencti-platform'
  | 'worker'
  | 'search'
  | 'redis'
  | 'rabbitmq'
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
   * read by key — 'platform' / 'worker' / 'search'. Absent tiers fall back to a
   * count of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for OpenCTI. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; OpenCTI has no forwarder tier. */
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
  data: 'Data tier — Elasticsearch, Redis, RabbitMQ & object storage',
  app: 'Application tier — OpenCTI platform',
  ingest: 'Ingest tier — workers',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app', 'ingest']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL OpenCTI stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // OpenCTI is open source (no BYOL license file); object storage is modeled as
  // a data-tier `minio` service below, so the foundation is network, optional
  // LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'OpenCTI GraphQL + web ingress (HTTP 4000)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'OpenCTI web/GraphQL (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin token · app secret · Redis/RabbitMQ/MinIO credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'OpenCTI node',
      role: 'All-in-one (platform + workers + Elasticsearch + Redis + RabbitMQ + MinIO)',
      region: primaryRegion,
      roles: ['platform', 'worker', 'search', 'redis', 'rabbitmq', 'minio'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: Elasticsearch/OpenSearch search cluster + fixed services ---
  const searchNodes = tierCount(input.tiers, 'search')
  const searchSites = assignNodeSites(searchNodes, tierPlacement(input.tiers, 'search'), primaryRegion)
  for (let i = 0; i < searchNodes; i++) {
    items.push({
      planKey: `data/search-${i + 1}`,
      tier: 'data',
      kind: 'search',
      name: searchNodes > 1 ? `Search node ${i + 1}` : 'Search node',
      role: i === 0 ? 'Elasticsearch / OpenSearch (primary)' : 'Elasticsearch / OpenSearch (data)',
      region: searchSites[i].region,
      zone: searchSites[i].zone,
      roles: ['search'],
    })
  }

  // Fixed supporting services — single instances in the main region (not user-scaled).
  items.push({ planKey: 'data/redis', tier: 'data', kind: 'redis', name: 'Redis', role: 'Cache · sessions · stream broker', region: primaryRegion })
  items.push({ planKey: 'data/rabbitmq', tier: 'data', kind: 'rabbitmq', name: 'RabbitMQ', role: 'Worker message broker (AMQP)', region: primaryRegion })
  items.push({ planKey: 'data/minio', tier: 'data', kind: 'minio', name: 'Object storage', role: 'S3-compatible file store (MinIO / S3)', region: primaryRegion })

  // --- Application tier: OpenCTI platform cluster (GraphQL + web) ---
  // The ALB target(s).
  const platformNodes = tierCount(input.tiers, 'platform')
  const platformSites = assignNodeSites(platformNodes, tierPlacement(input.tiers, 'platform'), primaryRegion)
  for (let i = 0; i < platformNodes; i++) {
    items.push({
      planKey: `app/opencti-platform-${i + 1}`,
      tier: 'app',
      kind: 'opencti-platform',
      name: platformNodes > 1 ? `Platform ${i + 1}` : 'Platform',
      role: i === 0 ? 'OpenCTI GraphQL API + web UI (primary)' : 'OpenCTI GraphQL API + web UI',
      region: platformSites[i].region,
      zone: platformSites[i].zone,
      roles: ['graphql', 'web'],
    })
  }

  // --- Ingest tier: OpenCTI workers ---
  const workerNodes = tierCount(input.tiers, 'worker')
  const workerSites = assignNodeSites(workerNodes, tierPlacement(input.tiers, 'worker'), primaryRegion)
  for (let i = 0; i < workerNodes; i++) {
    items.push({
      planKey: `ingest/worker-${i + 1}`,
      tier: 'ingest',
      kind: 'worker',
      name: workerNodes > 1 ? `Worker ${i + 1}` : 'Worker',
      role: 'Ingest / enrichment worker',
      region: workerSites[i].region,
      zone: workerSites[i].zone,
      roles: ['worker'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'data', title: 'Data services online', detail: 'Elasticsearch / OpenSearch, Redis, RabbitMQ and object storage boot and accept connections.' },
  { key: 'opencti-platform', title: 'OpenCTI platform booting', detail: 'The OpenCTI GraphQL API + web UI start and connect to the data services.' },
  { key: 'worker', title: 'Workers registering', detail: 'Ingest / enrichment workers connect to RabbitMQ and the platform.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'OpenCTI init / marking definitions, labels, groups and ingestion feeds.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the OpenCTI GraphQL API + web UI (4000) end to end.' },
]
