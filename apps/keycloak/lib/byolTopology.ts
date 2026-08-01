// =============================================================================
// BYOL resource-plan topology for the Keycloak stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end Keycloak cluster, grouped into tiers in provisioning order. The app
// SERVER uses it to seed `keycloak_byol_resource` rows on deploy.
//
// Keycloak is a Java/Quarkus Identity-and-Access-Management server backed by a
// relational datastore. It is modeled as ONE user-scalable node tier plus a
// single fixed supporting service:
//   • keycloak    Keycloak IAM server (Infinispan-clustered)  [app tier, ALB target]
//   • database    PostgreSQL, the Keycloak datastore           [data tier, single]
//   • standalone  all-in-one single box (Keycloak + PostgreSQL)
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexerCount/searchHeadCount
// fields. Only the scalable `server` tier accepts multi-site placement; the fixed
// PostgreSQL datastore is a single instance in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Keycloak-specific, and
// the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the Keycloak stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current Keycloak
// deployment guidance (www.keycloak.org → Server / High Availability guides)
// before treating these roles/ports as production-grade. A clustered Keycloak
// deployment forms an Infinispan cache cluster across the `server` nodes.
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
  // --- Keycloak node roles ---
  | 'keycloak'
  | 'database'
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
   * read by key — 'server'. Absent tiers fall back to a count of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for Keycloak. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; Keycloak has no forwarder tier. */
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
  app: 'Application tier — Keycloak',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL Keycloak stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // Keycloak is open source (no BYOL license file) and stores everything in
  // PostgreSQL (no object storage), so the foundation is network, optional
  // LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'Keycloak web / admin ingress (HTTP 8080)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'Keycloak web/admin (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin credentials · PostgreSQL credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'Keycloak node',
      role: 'All-in-one (Keycloak + PostgreSQL)',
      region: primaryRegion,
      roles: ['keycloak', 'postgres'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: PostgreSQL (single fixed datastore, not user-scaled) ---
  items.push({ planKey: 'data/postgres', tier: 'data', kind: 'database', name: 'PostgreSQL', role: 'Keycloak datastore', region: primaryRegion })

  // --- Application tier: Keycloak IAM server cluster (Infinispan-clustered) ---
  // The ALB target(s).
  const serverNodes = tierCount(input.tiers, 'server')
  const serverSites = assignNodeSites(serverNodes, tierPlacement(input.tiers, 'server'), primaryRegion)
  for (let i = 0; i < serverNodes; i++) {
    items.push({
      planKey: `app/keycloak-${i + 1}`,
      tier: 'app',
      kind: 'keycloak',
      name: serverNodes > 1 ? `Keycloak ${i + 1}` : 'Keycloak',
      role: i === 0 ? 'Keycloak IAM server (primary)' : 'Keycloak IAM server',
      region: serverSites[i].region,
      zone: serverSites[i].zone,
      roles: ['keycloak'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'data', title: 'PostgreSQL online', detail: 'The Keycloak datastore boots and accepts connections.' },
  { key: 'keycloak', title: 'Keycloak cluster booting', detail: 'The Keycloak IAM servers start, form the Infinispan cache cluster and connect to PostgreSQL.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Keycloak realms, clients, realm roles, groups and identity providers.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the Keycloak web / admin endpoint (8080) end to end.' },
]
