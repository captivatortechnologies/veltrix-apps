// Shared helpers for the Cisco Umbrella Internal Network Subnets config type
// (validate + deploy + rollback + drift).
//
// An Umbrella "Internal Network" (/deployments/v2/internalnetworks) is an
// RFC1918 (or non-RFC1918) subnet an organization uses behind a Virtual
// Appliance or tunnel, tied to exactly ONE of a Site, a (registered) Network,
// or a Tunnel — the association that scopes which DNS/Web policy applies to
// traffic from that subnet. Confirmed CRUD (POST/GET/PUT/DELETE) and the
// create/update body shape follow Cisco's own Refit-based Umbrella client
// (github.com/panoramicdata/Cisco.Api, Data/Umbrella/InternalNetwork*.cs).
//
// NOTE (naming): this is registered as "internal-network-subnets" — NOT
// "internal-networks" — because this app's pre-existing "internal-networks"
// config type already (confusingly) targets the different Umbrella *Networks*
// resource (/deployments/v2/networks, egress IPs). See lib/deployments.ts and
// DATAFLOW / CHANGELOG for the disambiguation.
//
// Internal Network Subnets are addressed by an opaque `originId` (no
// lookup-by-name), so a declared subnet is matched to a live one by NAME and
// the originId is stored after deploy for rename-safety. Verify against a
// live Umbrella tenant.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import {
  DEPLOYMENTS_NETWORKS_PATH,
  DEPLOYMENTS_SITES_PATH,
  DEPLOYMENTS_TUNNELS_PATH,
  DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH,
  listDeployment,
  type DeployableResource,
  type LiveResource,
} from '../../lib/deployments'
import type { UmbrellaClient } from '../../lib/umbrellaApi'

export const MAX_NAME_LENGTH = 50
// Cisco: "the prefix length must be greater than 8 and no more than 32."
export const MIN_PREFIX = 9
export const MAX_PREFIX = 32

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

export function isIpv4(value: string): boolean {
  return IPV4_RE.test(value.trim())
}

export type AssociationType = 'site' | 'network' | 'tunnel'
export const ASSOCIATION_TYPES: AssociationType[] = ['site', 'network', 'tunnel']

/** Runtime + type guard — used by validate.ts to flag an unknown value AND by
 * resolveAssociations to narrow a spec's raw (possibly invalid) associationType. */
export function isAssociationType(v: string): v is AssociationType {
  return (ASSOCIATION_TYPES as string[]).includes(v)
}

const ASSOCIATION_LABEL: Record<AssociationType, string> = {
  site: 'Site',
  network: 'Network',
  tunnel: 'Tunnel',
}

/** One internal network subnet declared on the canvas (one item), before its
 * association name has been resolved to an id. `associationType` is the RAW
 * declared value (only defaulted when blank) so validate.ts can flag an
 * unrecognized one instead of it being silently coerced away. */
export interface InternalNetworkSubnetSpec {
  itemId?: string
  /** name — the logical identity (Umbrella internal networks are originId-addressed). */
  name: string
  ipAddress: string
  prefixLength: number
  associationType: string
  /** Name of the Site / Network / Tunnel this subnet is tied to. */
  associationName: string
}

/** A spec once its association type/name has been validated and resolved to
 * Umbrella's opaque id. */
export interface ResolvedInternalNetworkSubnetSpec extends Omit<InternalNetworkSubnetSpec, 'associationType'> {
  associationType: AssociationType
  associationId: number
}

/** An internal network as returned by GET /deployments/v2/internalnetworks. */
export interface LiveInternalNetworkSubnet extends LiveResource {
  originId?: number | string
  name?: string
  ipAddress?: string
  prefixLength?: number
  siteName?: string
  siteId?: number | string
  networkName?: string
  networkId?: number | string
  tunnelName?: string
  tunnelId?: number | string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : MAX_PREFIX
}

/** Defaults only when blank — preserves an unrecognized value so validate.ts
 * can flag it, matching the app's `access: string` convention (destination-lists). */
function asAssociationType(v: unknown): string {
  return asString(v).toLowerCase() || 'site'
}

export function extractInternalNetworkSubnetSpecs(canvas: CanvasSnapshot): InternalNetworkSubnetSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    ipAddress: asString(item.fields?.ipAddress),
    prefixLength: asNumber(item.fields?.prefixLength),
    associationType: asAssociationType(item.fields?.associationType),
    associationName: asString(item.fields?.associationName),
  }))
}

/** Descriptor driving the generic deploy/rollback/drift engine, once every
 * spec's association has been resolved to a numeric id (see resolveAssociations). */
export const INTERNAL_NETWORK_SUBNET_RESOURCE: DeployableResource<ResolvedInternalNetworkSubnetSpec> = {
  label: 'internal network subnet',
  labelPlural: 'internal network subnets',
  collectionPath: DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH,
  resourcePath: (id) => `${DEPLOYMENTS_INTERNAL_NETWORK_SUBNETS_PATH}/${encodeURIComponent(String(id))}`,
  keyOfSpec: (spec) => spec.name.toLowerCase(),
  keyOfLive: (live) => asString((live as LiveInternalNetworkSubnet).name).toLowerCase(),
  nameOfSpec: (spec) => spec.name,
  idOfLive: (live) => (live as LiveInternalNetworkSubnet).originId,
  body: (spec) => {
    const body: Record<string, unknown> = {
      name: spec.name,
      ipAddress: spec.ipAddress,
      prefixLength: spec.prefixLength,
    }
    // Umbrella requires exactly one of siteId, networkId or tunnelId.
    if (spec.associationType === 'site') body.siteId = spec.associationId
    else if (spec.associationType === 'network') body.networkId = spec.associationId
    else body.tunnelId = spec.associationId
    return body
  },
  bodyFromLive: (live) => {
    const l = live as LiveInternalNetworkSubnet
    const body: Record<string, unknown> = {
      name: asString(l.name),
      ipAddress: asString(l.ipAddress),
      prefixLength: asNumber(l.prefixLength),
    }
    if (l.siteId != null) body.siteId = l.siteId
    if (l.networkId != null) body.networkId = l.networkId
    if (l.tunnelId != null) body.tunnelId = l.tunnelId
    return body
  },
}

export interface AssociationResolution {
  resolved: ResolvedInternalNetworkSubnetSpec[]
  /** Human-readable reasons a spec's association could not be resolved. */
  failures: string[]
}

const ASSOCIATION_PATH: Record<AssociationType, string> = {
  site: DEPLOYMENTS_SITES_PATH,
  network: DEPLOYMENTS_NETWORKS_PATH,
  tunnel: DEPLOYMENTS_TUNNELS_PATH,
}

function liveAssociationId(type: AssociationType, live: LiveResource): number | undefined {
  const l = live as Record<string, unknown>
  // Sites key off "siteId" (their own site number, distinct from originId);
  // Networks and Tunnels key off their originId / id.
  const raw = type === 'site' ? (l.siteId ?? l.originId) : type === 'network' ? l.originId : (l.originId ?? l.id)
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * Resolve every declared subnet's association NAME (a Site/Network/Tunnel) to
 * the opaque numeric id Umbrella's create/update body requires. Lists each
 * distinct collection at most once, regardless of how many specs reference it.
 * Best-effort: a spec whose association can't be resolved (unknown name, or
 * the lookup itself failed) is reported in `failures` and omitted from `resolved`.
 */
export async function resolveAssociations(
  client: UmbrellaClient,
  specs: InternalNetworkSubnetSpec[],
): Promise<AssociationResolution> {
  const neededTypes = [...new Set(specs.map((s) => s.associationType))].filter(isAssociationType)
  const idsByType = new Map<AssociationType, Map<string, number>>()

  for (const type of neededTypes) {
    const listed = await listDeployment(client, ASSOCIATION_PATH[type])
    const byName = new Map<string, number>()
    if (listed.ok) {
      for (const live of listed.items) {
        const id = liveAssociationId(type, live)
        const name = asString((live as Record<string, unknown>).name)
        if (id != null && name) byName.set(name.toLowerCase(), id)
      }
    }
    idsByType.set(type, byName)
  }

  const resolved: ResolvedInternalNetworkSubnetSpec[] = []
  const failures: string[] = []
  for (const spec of specs) {
    if (!isAssociationType(spec.associationType)) {
      failures.push(`"${spec.name}": unrecognized association type "${spec.associationType}"`)
      continue
    }
    const id = idsByType.get(spec.associationType)?.get(spec.associationName.toLowerCase())
    if (id == null) {
      failures.push(
        `"${spec.name}": ${ASSOCIATION_LABEL[spec.associationType]} "${spec.associationName}" was not found in Umbrella`,
      )
      continue
    }
    resolved.push({ ...spec, associationType: spec.associationType, associationId: id })
  }
  return { resolved, failures }
}
