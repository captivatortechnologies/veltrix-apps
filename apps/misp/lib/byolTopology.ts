// =============================================================================
// BYOL resource-plan topology for the MISP stack (app-owned, pure,
// dependency-free).
//
// Given a BYOL infrastructure (deployment type, node counts, provider, regions)
// this derives the FULL set of resources needed to stand up an end-to-end MISP
// stack, grouped into tiers in provisioning order. The app SERVER uses it to
// seed `misp_byol_resource` rows on deploy.
//
// MISP is a PHP/CakePHP threat-intel web app backed by MariaDB, with Redis
// driving its background workers (resque/supervisor). It is a single-node-ish
// stack — far simpler than Splunk / Security Onion — so the topology is modeled
// as three node roles across three tiers:
//   • misp-core   the MISP web UI + REST API + background workers  [app tier]
//                 — this is the ALB target (native HTTPS on 443).
//   • database    MariaDB, the MISP datastore                      [data tier]
//   • redis       Redis, the background job queue + cache          [data tier]
//   • standalone  all-in-one single box (web + workers + DB + Redis)
//
// The three shared BYOL node knobs (Splunk-shaped in the SDK form) are mapped,
// simplified, onto the MISP roles:
//   • indexerCount    → MariaDB database nodes   (database)  [data tier]
//   • searchHeadCount → MISP core web/API nodes  (misp-core) [app tier, ALB]
//   • heavyForwarderCount is unused — MISP has no sensor/forwarder analog; it is
//     carried on the record for SDK-form/DB compatibility but emits no rows.
// so the app reuses the SDK's Splunk-shaped form without a bespoke node editor.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is MISP-specific, and the
// app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.6.0). The SDK's client `byol` module keeps a Splunk-shaped copy for the
// browser Plan modal; here the SERVER owns the MISP stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current MISP deployment
// guidance (misp-project.org → INSTALL docs) before treating these roles/ports as
// production-grade.
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
  // --- MISP node roles ---
  | 'misp-core'
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
  /** Machine-readable roles this instance runs — drives post-deploy bring-up. */
  roles?: string[]
}

export interface ByolTopologyInput {
  deploymentType?: string
  /** MariaDB database nodes (database) in the data tier. */
  indexerCount?: number
  /** MISP core web/API nodes (misp-core) in the app tier. */
  searchHeadCount?: number
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  indexerRegions?: string[]
  searchHeadRegions?: string[]
  /** Control-plane consolidation layout — carried for record compatibility; unused for MISP. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; MISP has no sensor/forwarder tier. */
  heavyForwarderCount?: number
  /** Multi-site placement of the MariaDB database cluster (data tier only). */
  indexerPlacement?: ClusterPlacement | null
  /** Multi-site placement of the MISP core cluster (app tier only). */
  searchHeadPlacement?: ClusterPlacement | null
}

interface NodeSite {
  region: string | null
  zone: string | null
}

/**
 * Resolve the per-node region/zone for a cluster tier. Multi-site placement
 * (data / app tiers only) spreads nodes across sites by percent. Falls back to
 * the legacy per-node region round-robin otherwise.
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
  app: 'Application tier — MISP core',
  data: 'Data tier — MariaDB & Redis',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'app', 'data']

const DISTRIBUTED = 'distributed'

function pickRegion(regions: string[] | undefined, index: number, fallback: string | null): string | null {
  if (regions && regions.length > 0) return regions[index % regions.length]
  return fallback
}

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL MISP stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // No object storage (MISP attachments/data live on the misp-core volume) and no
  // BYOL license file (MISP is open source) — so the foundation is lean: network,
  // optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'MISP web UI + REST API ingress (HTTPS 443)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'MISP web UI (443) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'Admin password · MISP auth/salt keys · MariaDB credentials', region: null })

  if (!distributed) {
    items.push({ planKey: 'app/standalone', tier: 'app', kind: 'standalone', name: 'MISP node', role: 'All-in-one (web + workers + MariaDB + Redis)', region: primaryRegion })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Application tier: MISP core cluster (web UI + REST API + workers) ---
  // The ALB target(s). Only this tier and the data tier accept multi-site placement.
  const coreCount = Math.max(1, input.searchHeadCount ?? 1)
  const coreSites = assignNodeSites(coreCount, input.searchHeadPlacement, primaryRegion, input.searchHeadRegions)
  for (let i = 0; i < coreCount; i++) {
    items.push({
      planKey: `app/misp-core-${i + 1}`,
      tier: 'app',
      kind: 'misp-core',
      name: coreCount > 1 ? `MISP core ${i + 1}` : 'MISP core',
      role: i === 0 ? 'MISP web UI + REST API + background workers (primary)' : 'MISP web UI + REST API + background workers',
      region: coreSites[i].region,
      zone: coreSites[i].zone,
      roles: ['web', 'api', 'workers'],
    })
  }

  // --- Data tier: MariaDB cluster + Redis ---
  const dbCount = Math.max(1, input.indexerCount ?? 1)
  const dbSites = assignNodeSites(dbCount, input.indexerPlacement, primaryRegion, input.indexerRegions)
  for (let i = 0; i < dbCount; i++) {
    items.push({
      planKey: `data/database-${i + 1}`,
      tier: 'data',
      kind: 'database',
      name: dbCount > 1 ? `MariaDB ${i + 1}` : 'MariaDB',
      role: i === 0 ? 'MISP datastore (primary)' : 'MISP datastore (replica)',
      region: dbSites[i].region,
      zone: dbSites[i].zone,
    })
  }

  // Redis — a single background job queue + cache node (main region).
  items.push({ planKey: 'data/redis', tier: 'data', kind: 'redis', name: 'Redis', role: 'Background job queue + cache', region: primaryRegion })

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'database', title: 'MariaDB online', detail: 'The MISP datastore boots and accepts connections.' },
  { key: 'redis', title: 'Redis online', detail: 'The background job queue + cache comes up.' },
  { key: 'misp-core', title: 'MISP core booting', detail: 'The MISP web UI + REST API start; background workers register.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'MISP install / DB init / feeds, taxonomies and warninglists.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the MISP web UI + REST API (/users/login) end to end.' },
]
