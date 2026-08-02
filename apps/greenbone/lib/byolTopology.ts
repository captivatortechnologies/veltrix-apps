// =============================================================================
// BYOL resource-plan topology for the Greenbone / OpenVAS stack (app-owned,
// pure, dependency-free).
//
// Given a BYOL infrastructure (deployment type, per-tier node counts, provider,
// regions) this derives the FULL set of resources needed to stand up an
// end-to-end Greenbone vulnerability-scanning stack, grouped into tiers in
// provisioning order. The app SERVER uses it to seed `greenbone_byol_resource`
// rows on deploy.
//
// Greenbone is a multi-service vulnerability-management platform: a MANAGER
// (gvmd, the Greenbone Vulnerability Manager, plus the GSA web UI — the ALB
// target) that speaks GMP, a pool of SCANNERS (openvas-scanner) that execute the
// feed's network vulnerability tests, plus two fixed supporting services —
// PostgreSQL (gvmd's database) and Redis (the scanner key-value store). It is
// modeled as two USER-SCALABLE node tiers plus the fixed supporting infra:
//   • manager   gvmd + GSA web UI (GMP 9390 / HTTPS 443)  [app tier, ALB target]
//   • scanner   openvas-scanner nodes                      [scan tier]
//   • postgres  gvmd database                              [data tier, single]
//   • redis     scanner key-value store                    [data tier, single]
//   • standalone all-in-one single box (every role)        [app tier]
//
// NODE_TIERS-NATIVE: node counts + placement come from the generic per-tier
// `tiers` array (persisted in the `node_tiers` JSONB column). Counts are read BY
// KEY via `tierCount()` — there are NO Splunk-shaped indexerCount/searchHeadCount
// fields. Only the two scalable tiers accept multi-site placement; the fixed
// supporting services are single instances in the main region.
//
// WHY THIS LIVES IN THE APP (not the SDK): the topology is Greenbone-specific,
// and the app must not depend on an SDK export that may be absent in whatever
// @veltrixsecops/app-sdk version the platform packages the app against (the app
// pins ^3.7.0). The SDK's client `byol` module owns the browser form; here the
// SERVER owns the Greenbone stack mapping.
//
// ⚠ STACK SIZING IS A REASONABLE DEFAULT — VERIFY against current Greenbone /
// GVM deployment guidance (greenbone.github.io → GVM architecture) before
// treating these roles/ports as production-grade.
// =============================================================================

import {
  effectivePlacement,
  allocateNodesBySite,
  type ClusterPlacement,
} from './byolPlacement'

export type ByolResourceTier = 'foundation' | 'data' | 'app' | 'scan'

export type ByolResourceKind =
  // --- Foundation kinds ---
  | 'network'
  | 'load-balancer'
  | 'dns'
  | 'tls'
  | 'secrets'
  // --- Greenbone node roles ---
  | 'greenbone'
  | 'scanner'
  | 'postgres'
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
   * read by key — 'manager' / 'scanner'. Absent tiers fall back to a count of 1.
   */
  tiers?: TopologyTier[]
  hostingType?: string
  isCloud?: boolean
  region?: string | null
  /** Control-plane consolidation layout — carried for record compatibility; unused for Greenbone. */
  controlPlaneLayout?: string
  /** Carried for record compatibility; Greenbone has no forwarder tier. */
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
  data: 'Data tier — PostgreSQL & Redis',
  app: 'Manager tier — gvmd + GSA web',
  scan: 'Scanner tier — openvas-scanner',
}

/** Provisioning order the tiers deploy in (also the display order). */
export const TIER_ORDER: ByolResourceTier[] = ['foundation', 'data', 'app', 'scan']

const DISTRIBUTED = 'distributed'

function stampOrder(item: ByolResourcePlanItem, index: number): ByolResourcePlanItem & { sortOrder: number } {
  return { ...item, sortOrder: index }
}

export type ByolResourcePlanItemWithOrder = ReturnType<typeof stampOrder>

/** Build the ordered resource plan for a BYOL Greenbone stack. */
export function buildByolResourcePlan(input: ByolTopologyInput): ByolResourcePlanItemWithOrder[] {
  const distributed = (input.deploymentType ?? 'single') === DISTRIBUTED
  const primaryRegion = input.region ?? null
  const isCloud = input.isCloud ?? false
  const items: ByolResourcePlanItem[] = []

  // --- Foundation ---
  // Greenbone / OpenVAS is open source (no BYOL license file); the feed syncs
  // from the Greenbone Community/Enterprise feed at bring-up, so the foundation
  // is network, optional LB/DNS, TLS and secrets only.
  items.push({ planKey: 'foundation/network', tier: 'foundation', kind: 'network', name: 'Network', role: 'VPC · subnets · security groups', region: primaryRegion })
  if (distributed && isCloud) {
    items.push({ planKey: 'foundation/load-balancer', tier: 'foundation', kind: 'load-balancer', name: 'Load balancer', role: 'GSA web ingress (HTTPS 443)', region: primaryRegion })
    items.push({ planKey: 'foundation/dns', tier: 'foundation', kind: 'dns', name: 'DNS', role: 'Public + private records', region: 'global' })
  }
  items.push({ planKey: 'foundation/tls', tier: 'foundation', kind: 'tls', name: 'TLS certificates', role: 'GSA web (443) + GMP (9390) + inter-node', region: null })
  items.push({ planKey: 'foundation/secrets', tier: 'foundation', kind: 'secrets', name: 'Secrets', role: 'gvmd admin · PostgreSQL & Redis credentials', region: null })

  if (!distributed) {
    items.push({
      planKey: 'app/standalone',
      tier: 'app',
      kind: 'standalone',
      name: 'Greenbone node',
      role: 'All-in-one (gvmd + GSA + openvas-scanner + PostgreSQL + Redis)',
      region: primaryRegion,
      roles: ['gvmd', 'gsa', 'scanner', 'postgres', 'redis'],
    })
    return items.map((it, i) => stampOrder(it, i))
  }

  // --- Data tier: fixed supporting services ---
  // Single instances in the main region (not user-scaled).
  items.push({ planKey: 'data/postgres', tier: 'data', kind: 'postgres', name: 'PostgreSQL', role: 'gvmd database', region: primaryRegion })
  items.push({ planKey: 'data/redis', tier: 'data', kind: 'redis', name: 'Redis', role: 'Scanner key-value store', region: primaryRegion })

  // --- Application tier: Greenbone manager cluster (gvmd + GSA web) ---
  // The ALB target(s).
  const managerNodes = tierCount(input.tiers, 'manager')
  const managerSites = assignNodeSites(managerNodes, tierPlacement(input.tiers, 'manager'), primaryRegion)
  for (let i = 0; i < managerNodes; i++) {
    items.push({
      planKey: `app/manager-${i + 1}`,
      tier: 'app',
      kind: 'greenbone',
      name: managerNodes > 1 ? `Manager ${i + 1}` : 'Manager',
      role: i === 0 ? 'gvmd (GMP) + GSA web UI (primary)' : 'gvmd (GMP) + GSA web UI',
      region: managerSites[i].region,
      zone: managerSites[i].zone,
      roles: ['gvmd', 'gsa'],
    })
  }

  // --- Scan tier: openvas-scanner nodes ---
  const scannerNodes = tierCount(input.tiers, 'scanner')
  const scannerSites = assignNodeSites(scannerNodes, tierPlacement(input.tiers, 'scanner'), primaryRegion)
  for (let i = 0; i < scannerNodes; i++) {
    items.push({
      planKey: `scan/scanner-${i + 1}`,
      tier: 'scan',
      kind: 'scanner',
      name: scannerNodes > 1 ? `Scanner ${i + 1}` : 'Scanner',
      role: 'openvas-scanner (network vulnerability tests)',
      region: scannerSites[i].region,
      zone: scannerSites[i].zone,
      roles: ['scanner'],
    })
  }

  return items.map((it, i) => stampOrder(it, i))
}

/** The ordered high-level steps a deployment run advances through. */
export const DEPLOYMENT_STEPS: Array<{ key: string; title: string; detail: string }> = [
  { key: 'plan', title: 'Plan created', detail: 'Resources planned from stack topology; desired state recorded.' },
  { key: 'foundation', title: 'Provision foundation', detail: 'Network, load balancer, DNS, TLS and secrets.' },
  { key: 'data', title: 'Data services online', detail: 'PostgreSQL and Redis boot and accept connections.' },
  { key: 'greenbone', title: 'Manager booting', detail: 'gvmd + the GSA web UI start, connect to PostgreSQL/Redis and begin the feed sync.' },
  { key: 'scanner', title: 'Scanners registering', detail: 'openvas-scanner nodes connect to gvmd and load the vulnerability feed.' },
  { key: 'post-config', title: 'Post-deploy configuration', detail: 'gvmd admin user, feed sync completion, scan configs, targets and scanners.' },
  { key: 'health', title: 'End-to-end health check', detail: 'Verify the GSA web UI (443) + GMP (9390) end to end.' },
]
