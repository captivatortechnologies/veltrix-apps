// =============================================================================
// BYOL resource-plan topology for the authentik stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end authentik identity-provider stack. The app SERVER uses it to seed
// `authentik_byol_resource` rows on deploy.
//
// authentik ships ONE container image that runs as either role via its startup
// COMMAND — `server` (the web/API process, HTTP 9000 / HTTPS 9443) or `worker`
// (background tasks: scheduled jobs, outpost sync, LDAP/SCIM providers, flow
// stage execution). It is modeled as TWO USER-SCALABLE node tiers plus the
// fixed supporting infra:
//   • server      authentik server (web/API, ALB target)   [app tier]
//   • worker      authentik worker (background tasks)      [worker tier]
//   • postgres    authentik's database                      [data tier, single]
//   • standalone  all-in-one single box (server + worker + postgres)  [app tier]
//
// ⚠ NO REDIS — VERIFIED, NOT AN OVERSIGHT. Older authentik releases used Redis
// for caching, the task broker, the embedded outpost's session store and
// WebSocket connections. As of **authentik 2025.10** this was fully removed:
// "In previous versions, authentik used Redis for caching, tasks, the embedded
// proxy outpost's session store, and WebSocket connections. Since 2025.8, tasks
// were migrated to use Postgres. With this release we've also migrated caching,
// the embedded outpost, and WebSocket to Postgres, fully removing the need for
// Redis." (authentik 2025.10 release notes,
// https://docs.goauthentik.io/releases/2025.10/ — "Breaking changes"). This is
// corroborated by the CURRENT official docker-compose.yml
// (https://docs.goauthentik.io/compose.yml, tag 2026.5.6 at the time of
// research) and the official Helm chart's values.yaml
// (https://raw.githubusercontent.com/goauthentik/helm/main/charts/authentik/values.yaml)
// — neither references Redis anywhere; both wire `server` and `worker` to
// PostgreSQL only. A prior draft of this topology assumed a Redis data tier
// (mirroring other BYOL stacks that DO need one); it was DROPPED after this
// verification rather than modeled to match a template that no longer reflects
// current authentik architecture.
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexerCount/searchHeadCount
// fields. Only the two scalable tiers accept multi-site placement; the fixed
// supporting service is a single instance in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is authentik-specific,
// and the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the authentik stack mapping.
//
// ⚠ STACK SIZING (compute size, node counts) IS A REASONABLE DEFAULT — VERIFY
// against current authentik deployment guidance
// (docs.goauthentik.io/docs/install-config) before treating these roles/ports
// as production-grade for your scale.
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'data' | 'app' | 'worker'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- authentik node roles ---
  | 'authentik-server'
  | 'authentik-worker'
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
   * read by key — 'server' / 'worker'. Absent tiers fall back to a count of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for authentik. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; authentik has no forwarder tier. */
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
  data: 'Data tier — PostgreSQL',
  app: 'Server tier — authentik server (web/API)',
  worker: 'Worker tier — authentik worker (background tasks)',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app', 'worker']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL authentik stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // authentik is open source (no BYOL license file); there is no feed sync, so
  // the foundation is network, optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'authentik server web ingress (HTTPS 443 → HTTP 9000)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'authentik web (443/9443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'AUTHENTIK_SECRET_KEY · bootstrap admin token · PostgreSQL credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'authentik node',
      role: 'All-in-one (server + worker + PostgreSQL)',
      region: primaryRegion,
      roles: ['server', 'worker', 'postgres'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: fixed supporting service ---
  // A single instance in the main region (not user-scaled). No Redis — see the
  // module docs above (removed in authentik 2025.10).
  items.push({ planKey: 'data/postgres', tier: 'data', kind: 'postgres', name: 'PostgreSQL', role: 'authentik database', region: primaryRegion })

  // --- Application tier: authentik server (web/API) ---
  // The ALB target(s). Same image as the worker tier; started with `server`.
  const serverNodes = tierCount(input.tiers, 'server')
  const serverSites = assignNodeSites(serverNodes, tierPlacement(input.tiers, 'server'), primaryRegion)
  for (let i = 0; i < serverNodes; i++) {
    items.push({
      planKey: `app/server-${i + 1}`,
      tier: 'app',
      kind: 'authentik-server',
      name: serverNodes > 1 ? `Server ${i + 1}` : 'Server',
      role: i === 0 ? 'authentik server — web/API (primary)' : 'authentik server — web/API',
      region: serverSites[i].region,
      zone: serverSites[i].zone,
      roles: ['server'],
    })
  }

  // --- Worker tier: authentik worker (background tasks) ---
  // Same image as the server tier; started with `worker`. No inbound ports.
  const workerNodes = tierCount(input.tiers, 'worker')
  const workerSites = assignNodeSites(workerNodes, tierPlacement(input.tiers, 'worker'), primaryRegion)
  for (let i = 0; i < workerNodes; i++) {
    items.push({
      planKey: `worker/worker-${i + 1}`,
      tier: 'worker',
      kind: 'authentik-worker',
      name: workerNodes > 1 ? `Worker ${i + 1}` : 'Worker',
      role: 'authentik worker — background tasks (scheduled jobs, outpost sync, flow stages)',
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
  { key: 'data', title: 'Data services online', detail: 'PostgreSQL boots and accepts connections.' },
  { key: 'authentik-server', title: 'Server booting', detail: 'authentik server processes start, run database migrations and connect to PostgreSQL.' },
  { key: 'authentik-worker', title: 'Worker registering', detail: 'authentik worker processes start and begin processing scheduled tasks and outpost sync.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Bootstrap admin user/token, default flows and branding.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the server web UI (443/9000) and /-/health/live/ + /-/health/ready/.' },
]
