// =============================================================================
// BYOL resource-plan topology for the Velociraptor stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end Velociraptor server stack, grouped into tiers in provisioning
// order. The app SERVER uses it to seed `velociraptor_byol_resource` rows on
// deploy.
//
// Velociraptor is a Go endpoint DFIR / hunting platform. A distributed deploy
// runs multiple Velociraptor SERVER (frontend) nodes behind a load balancer, all
// sharing a single S3/MinIO file+datastore backend — so the topology is modeled
// as two user-scalable node roles across an app tier and a data tier, plus the
// shared foundation:
//   • velociraptor-server  the Velociraptor server: GUI (8889) + frontend (8000,
//                          endpoint client comms) + gRPC API (8001)  [app tier]
//                          — this is the ALB target.
//   • datastore            MinIO (S3-compatible file+datastore, 9000)  [data tier]
//                          — the shared backend every frontend reads/writes.
//   • standalone           all-in-one single box (server + embedded datastore)
//
// This app is node_tiers-NATIVE: counts are read BY KEY off the generic
// `tiers: [{ key, count, placement }]` list the SDK form persists (see
// lib/byolInput.ts + lib/db) — there is no legacy indexer/search-head pair.
//   • tiers['frontend']  → Velociraptor server nodes (velociraptor-server) [app tier, ALB]
//   • tiers['datastore'] → MinIO datastore nodes     (datastore)           [data tier]
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Velociraptor-specific,
// and the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against. The SDK's
// client `byol` module keeps a Splunk-shaped copy for the browser Plan modal;
// here the SERVER owns the Velociraptor stack mapping.
//
// ⚠ STACK SIZING / PORTS ARE A REASONABLE DEFAULT — VERIFY against current
// Velociraptor deployment guidance (docs.velociraptor.app) before treating these
// roles/ports as production-grade.
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'app' | 'data'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- Velociraptor node roles ---
  | 'velociraptor-server'
  | 'datastore'
  | 'standalone'

/** A single tier's persisted count + placement (the generic `node_tiers` entry). */
export interface NodeTierInput {
  key: string
  count: number
  placement: ClusterPlacement | null
}

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

export interface ByolTopologyInput {
  deploymentType?: string
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for Velociraptor. */
  controlPlaneLayout?: string
  /** Generic per-tier node counts + placement, keyed to this app's topology. */
  tiers?: NodeTierInput[]
}

interface NodeSite {
  region: string | null
  zone: string | null
}

/** Look up a tier's node count by key (min 1); falls back to `fallback` when absent. */
export function tierCount(input: ByolTopologyInput, key: string, fallback = 1): number {
  const tier = (input.tiers ?? []).find((t) => t.key === key)
  return Math.max(1, Math.floor(tier?.count ?? fallback))
}

/** Look up a tier's multi-site placement by key, or null when absent / single-site. */
export function tierPlacement(input: ByolTopologyInput, key: string): ClusterPlacement | null {
  const tier = (input.tiers ?? []).find((t) => t.key === key)
  return tier?.placement ?? null
}

/**
 * Resolve the per-node region/zone for a cluster tier. Multi-site placement
 * (app / data tiers) spreads nodes across sites by percent; otherwise every node
 * lands in the primary region.
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
  app: 'Application tier — Velociraptor frontend',
  data: 'Data tier — MinIO datastore',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'app', 'data']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL Velociraptor stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // Velociraptor is open source (no BYOL license file). Object storage is the
  // MinIO datastore (a compute node in the data tier), not a foundation bucket —
  // so the foundation is lean: network, optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'Velociraptor GUI (8889) + frontend (8000) ingress', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'Velociraptor GUI (8889) + frontend/API mutual TLS', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · server/frontend keys · MinIO credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'Velociraptor node',
      role: 'All-in-one (server GUI + frontend + gRPC API + embedded datastore)',
      region: primaryRegion,
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Application tier: Velociraptor frontend cluster (GUI + frontend + API) ---
  // The ALB target(s). Multiple frontends scale horizontally, all pointing at the
  // shared MinIO datastore. Only this tier and the data tier accept multi-site.
  const frontendCount = tierCount(input, 'frontend')
  const frontendSites = assignNodeSites(frontendCount, tierPlacement(input, 'frontend'), primaryRegion)
  for (let i = 0; i < frontendCount; i++) {
    items.push({
      planKey: `app/frontend-${i + 1}`,
      tier: 'app',
      kind: 'velociraptor-server',
      name: frontendCount > 1 ? `Frontend ${i + 1}` : 'Frontend',
      role: i === 0 ? 'Velociraptor server — GUI + frontend + gRPC API (primary)' : 'Velociraptor server — GUI + frontend + gRPC API',
      region: frontendSites[i].region,
      zone: frontendSites[i].zone,
      roles: ['gui', 'frontend', 'api'],
    })
  }

  // --- Data tier: MinIO datastore cluster (shared file+datastore backend) ---
  const datastoreCount = tierCount(input, 'datastore')
  const datastoreSites = assignNodeSites(datastoreCount, tierPlacement(input, 'datastore'), primaryRegion)
  for (let i = 0; i < datastoreCount; i++) {
    items.push({
      planKey: `data/datastore-${i + 1}`,
      tier: 'data',
      kind: 'datastore',
      name: datastoreCount > 1 ? `MinIO ${i + 1}` : 'MinIO',
      role: i === 0 ? 'Shared file + datastore backend (MinIO S3, primary)' : 'Shared file + datastore backend (MinIO S3, member)',
      region: datastoreSites[i].region,
      zone: datastoreSites[i].zone,
      roles: ['minio'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'datastore', title: 'MinIO datastore online', detail: 'The shared S3/MinIO file+datastore backend boots and accepts connections.' },
  { key: 'frontend', title: 'Velociraptor frontends booting', detail: 'The Velociraptor server GUI + frontend + gRPC API start, pointed at the shared datastore.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'Server config generation, GUI admin user, artifact + monitoring bring-up.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the Velociraptor GUI + frontend end to end.' },
]
