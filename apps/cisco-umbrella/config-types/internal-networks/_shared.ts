// Shared helpers for the Cisco Umbrella Networks config type
// (validate + deploy + rollback + drift).
//
// A "network" here is an Umbrella registered network (/deployments/v2/networks):
// an egress/public IP range Umbrella applies DNS-layer policy to. Networks are
// addressed by an opaque `originId` (no lookup-by-name), so a declared network is
// matched to a live one by NAME and the originId is stored after deploy for
// rename-safety. Shapes follow the Umbrella Deployments API; verify against a
// live Umbrella tenant.
//
// NOTE (naming): this config type is registered as "internal-networks" but the
// endpoint (/deployments/v2/networks) and fields (name, ipAddress, prefixLength,
// isDynamic) are the Umbrella *Networks* (registered network) API — distinct from
// /deployments/v2/internalnetworks, which models RFC-1918 subnets tied to a
// Site/Network/Tunnel. See DATAFLOW / CHANGELOG.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import {
  DEPLOYMENTS_NETWORKS_PATH,
  type DeployableResource,
  type LiveResource,
} from '../../lib/deployments'

export const MAX_NAME_LENGTH = 50
export const MIN_PREFIX = 0
export const MAX_PREFIX = 32

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

export function isIpv4(value: string): boolean {
  return IPV4_RE.test(value.trim())
}

/** One network declared on the canvas (one item). */
export interface NetworkSpec {
  itemId?: string
  /** name — the logical identity (Umbrella networks are originId-addressed). */
  name: string
  ipAddress: string
  prefixLength: number
  isDynamic: boolean
}

/** A network as returned by GET /deployments/v2/networks. */
export interface LiveNetwork extends LiveResource {
  originId?: number | string
  id?: number | string
  name?: string
  ipAddress?: string
  prefixLength?: number
  isDynamic?: boolean
  isVerified?: boolean
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return v === 'true' || v === 1 || v === '1'
}

function asPrefix(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? Math.trunc(n) : MAX_PREFIX
}

export function extractNetworkSpecs(canvas: CanvasSnapshot): NetworkSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    ipAddress: asString(item.fields?.ipAddress),
    prefixLength: asPrefix(item.fields?.prefixLength),
    isDynamic: asBoolean(item.fields?.isDynamic),
  }))
}

function liveId(live: LiveResource): string | number | undefined {
  const l = live as LiveNetwork
  return l.originId ?? l.id
}

/** Descriptor driving the generic deploy/rollback/drift engine for networks. */
export const NETWORK_RESOURCE: DeployableResource<NetworkSpec> = {
  label: 'network',
  labelPlural: 'networks',
  collectionPath: DEPLOYMENTS_NETWORKS_PATH,
  resourcePath: (id) => `${DEPLOYMENTS_NETWORKS_PATH}/${encodeURIComponent(String(id))}`,
  keyOfSpec: (spec) => spec.name.toLowerCase(),
  keyOfLive: (live) => asString((live as LiveNetwork).name).toLowerCase(),
  nameOfSpec: (spec) => spec.name,
  idOfLive: liveId,
  body: (spec) => {
    const body: Record<string, unknown> = {
      name: spec.name,
      prefixLength: spec.prefixLength,
      isDynamic: spec.isDynamic,
    }
    // Dynamic networks track a changing egress IP; only send ipAddress when set.
    if (spec.ipAddress) body.ipAddress = spec.ipAddress
    return body
  },
  bodyFromLive: (live) => {
    const l = live as LiveNetwork
    const body: Record<string, unknown> = {
      name: asString(l.name),
      prefixLength: asPrefix(l.prefixLength),
      isDynamic: asBoolean(l.isDynamic),
    }
    if (l.ipAddress) body.ipAddress = asString(l.ipAddress)
    return body
  },
}
