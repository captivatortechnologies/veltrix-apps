// =============================================================================
// BYOL network + tag enrichment (app-owned).
//
// Bridges a BYOL infrastructure record to the generic platform network allocator
// (networkClient.ts) and the canonical tag builder (byolTags.ts). The app owns
// the POLICY here — which provider/region a stack targets and what subnet size
// it asks for — while the platform owns the shared Network, the global CIDR
// ledger, and the atomic reservation.
//
//   • resolvePlanNetwork  — side-effect-free: peek a candidate subnet + derive
//     tags for `GET /byol/:id/plan`. Degrades softly (never throws) so a plan
//     never 500s when the allocator is down or absent.
//   • reserveDeployNetwork — commit: atomically reserve the subnet + derive tags
//     for `POST /byol/:id/deploy`. Re-throws a 409 conflict (the caller surfaces
//     a "re-plan" error); other transport errors degrade to a tag-only result so
//     the (still-modeled) apply proceeds.
// =============================================================================

import { buildByolTags, type ByolTags } from './byolTags'
import {
  isNetworkApiConfigured,
  peekAllocation,
  reserveAllocation,
  NetworkAllocationConflictError,
  type NetworkAllocation,
} from './networkClient'

// Re-export so routes import the conflict type from a single surface.
export { NetworkAllocationConflictError } from './networkClient'

/** The minimal infra shape the network + tag enrichment reads. */
export interface ByolNetworkInfra {
  id: string
  name: string
  environmentType: string
  region: string | null
  hosting_type: string
  cloudProviderId: string | null
}

/** The subnet a stack carries (superset of the plan's `network` block). */
export interface ByolNetworkRef {
  networkRef: string
  subnetCidr: string
  /** Ledger row id — present only after a commit (reserve), not a peek. */
  allocationId?: string
}

export interface PlanNetworkResult {
  tags: ByolTags
  network?: { networkRef: string; subnetCidr: string }
  /** True when the allocator was applicable but unreachable (soft flag). */
  networkUnavailable?: boolean
}

export interface DeployNetworkResult {
  tags: ByolTags
  network?: ByolNetworkRef
}

/**
 * Map a display hosting name to a provider code the allocator understands.
 * A self-hosted stack (no cloud provider) returns null — no Veltrix Network
 * allocation applies (BYOI customers use Access Servers instead).
 */
const PROVIDER_ALIASES: Record<string, string> = {
  aws: 'aws',
  amazon: 'aws',
  'amazon web services': 'aws',
  azure: 'azure',
  microsoft: 'azure',
  'microsoft azure': 'azure',
  gcp: 'gcp',
  google: 'gcp',
  'google cloud': 'gcp',
  'google cloud platform': 'gcp',
  hetzner: 'hetzner',
  hcloud: 'hetzner',
}

export function deriveProviderCode(infra: ByolNetworkInfra): string | null {
  // Gate on a real cloud provider being attached — self-hosted has no Network.
  if (!infra.cloudProviderId) return null
  const key = (infra.hosting_type ?? '').trim().toLowerCase()
  if (!key) return null
  return PROVIDER_ALIASES[key] ?? key
}

/**
 * The subnet prefix (mask length) a stack requests. The resolved network model
 * gives every stack a /24 within its customer's block; kept as a function so the
 * policy can later widen for larger distributed clusters.
 */
export function deriveSubnetPrefix(_infra: ByolNetworkInfra): number {
  return 24
}

/** Build the allocator request for an infra, or null when a Network does not apply. */
function networkRequestFor(
  infra: ByolNetworkInfra,
  customerId: string,
): { provider: string; region: string; customerId: string } | null {
  const provider = deriveProviderCode(infra)
  const region = (infra.region ?? '').trim()
  if (!provider || !region) return null
  return { provider, region, customerId }
}

/** Derive the canonical tag set for an infra. */
function tagsFor(
  infra: ByolNetworkInfra,
  customerId: string,
  appId: string,
  customerShortName?: string | null,
): ByolTags {
  return buildByolTags({
    customerId,
    customerShortName,
    infrastructureId: infra.id,
    name: infra.name,
    environmentType: infra.environmentType,
    appId,
  })
}

/**
 * Plan enrichment (side-effect-free): derive tags + peek a candidate subnet.
 * Never throws — the plan degrades to a tag-only result (with a soft
 * `networkUnavailable` flag when a cloud stack's allocator is unreachable).
 */
export async function resolvePlanNetwork(
  infra: ByolNetworkInfra,
  customerId: string,
  appId: string,
  customerShortName?: string | null,
): Promise<PlanNetworkResult> {
  const tags = tagsFor(infra, customerId, appId, customerShortName)
  const request = networkRequestFor(infra, customerId)

  // Self-hosted / no region → a Network genuinely does not apply (no flag).
  if (!request) return { tags }
  // Cloud stack, but the allocator is not wired yet (Phase 2a) → soft flag.
  if (!isNetworkApiConfigured()) return { tags, networkUnavailable: true }

  try {
    const peek = await peekAllocation({ ...request, prefix: deriveSubnetPrefix(infra) })
    return { tags, network: { networkRef: peek.networkRef, subnetCidr: peek.subnetCidr } }
  } catch (err) {
    console.error('[splunk-enterprise] network allocation peek failed:', err)
    return { tags, networkUnavailable: true }
  }
}

/**
 * Deploy enrichment (commit): derive tags + atomically reserve the subnet.
 * Re-throws NetworkAllocationConflictError (409) so the route can tell the user
 * to re-plan; any other failure degrades to a tag-only result so the modeled
 * apply still proceeds.
 */
export async function reserveDeployNetwork(
  infra: ByolNetworkInfra,
  opts: { customerId: string; appId: string; infrastructureId: string; customerShortName?: string | null },
): Promise<DeployNetworkResult> {
  const tags = tagsFor(infra, opts.customerId, opts.appId, opts.customerShortName)
  const request = networkRequestFor(infra, opts.customerId)

  if (!request || !isNetworkApiConfigured()) return { tags }

  try {
    const alloc: NetworkAllocation = await reserveAllocation({
      ...request,
      appId: opts.appId,
      infrastructureId: opts.infrastructureId,
      prefix: deriveSubnetPrefix(infra),
    })
    return {
      tags,
      network: { networkRef: alloc.networkRef, subnetCidr: alloc.subnetCidr, allocationId: alloc.allocationId },
    }
  } catch (err) {
    if (err instanceof NetworkAllocationConflictError) throw err
    console.error('[splunk-enterprise] network allocation reserve failed:', err)
    return { tags }
  }
}
