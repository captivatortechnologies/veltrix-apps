// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense static-routes
// config type (`/api/routes/routes/*route`, `/api/routes/routes/reconfigure`
// — see lib/staticRoutesApi.ts's module doc). No meaningful OPNsense version
// floor.
//
// IDENTITY: `network` is the model's own required field and the only
// meaningful natural key for a route (you would not normally declare the
// exact same destination network twice) — this app reconciles by it, deduped
// case-insensitively per canvas, even though the model itself does not
// enforce uniqueness.
//
// `gateway` is a JsonKeyValueStoreField populated dynamically from OPNsense's
// OWN configured gateway list (`interface gateways list -g`) — this app
// cannot enumerate or validate it offline; it is passed through as a plain
// gateway NAME and left to OPNsense's own validation to accept or reject.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { LiveRoute, RouteBody } from '../../lib/staticRoutesApi'

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Trim a string field, defaulting to the canvas item's own `name` ONLY when
 * the raw field value was never provided (undefined/null). An EXPLICIT empty
 * string is preserved as-is, so a required field left genuinely blank is
 * still caught by validate.ts instead of being silently masked by the
 * item's unrelated `name` metadata.
 */
function asStringOrItemName(value: unknown, itemName: string): string {
  if (value === undefined || value === null) return itemName
  return asString(value)
}

export function routeKey(network: string): string {
  return network.trim().toLowerCase()
}

export interface RouteSpec {
  itemId?: string
  network: string
  gateway: string
  descr: string
  enabled: boolean
}

export function extractRouteSpecs(canvas: CanvasSnapshot): RouteSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      network: asStringOrItemName(f.network, item.name),
      gateway: asString(f.gateway),
      descr: asString(f.descr),
      enabled: asBool(f.enabled, true),
    }
  })
}

export function buildRouteBody(spec: RouteSpec): RouteBody {
  return {
    network: spec.network,
    gateway: spec.gateway,
    descr: spec.descr,
    enabled: spec.enabled ? '1' : '0',
  }
}

export function snapshotLive(live: LiveRoute): RouteBody {
  return {
    network: String(live.network ?? ''),
    gateway: String(live.gateway ?? ''),
    descr: String(live.descr ?? ''),
    enabled: String(live.enabled ?? '1'),
  }
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
function isValidIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value)
  return !!m && [1, 2, 3, 4].every((i) => Number(m[i]) <= 255)
}

// Pragmatic (not exhaustively RFC 4291-complete) IPv6 matcher, shared in spirit with firewall-aliases' own.
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/
function isValidIpv6(value: string): boolean {
  return IPV6_RE.test(value)
}

/** `ip/prefixlen` — NetMaskRequired=Y on this model's `network` field, so a bare IP is not accepted. */
export function isValidCidr(value: string): boolean {
  const parts = value.split('/')
  if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1])) return false
  const prefix = Number(parts[1])
  if (isValidIpv4(parts[0])) return prefix <= 32
  if (isValidIpv6(parts[0])) return prefix <= 128
  return false
}
