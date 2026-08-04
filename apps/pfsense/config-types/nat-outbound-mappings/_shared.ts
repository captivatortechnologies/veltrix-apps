// =============================================================================
// Shared helpers for the NAT Outbound Mappings config type (validate +
// deploy + rollback + drift). Field shapes verified against
// RESTAPI/Models/OutboundNATMapping.inc — a deliberately-scoped SUBSET of
// its 16 fields (see lib/pfsenseApi.ts's OutboundNatMapping doc for the
// dropped-field list). See lib/pfsenseApi.ts's module doc for the ordering
// and apply-endpoint citations.
//
// IDENTITY: like firewall-rules/nat-port-forwards, OutboundNATMapping
// declares no unique/name field (verified) — this config type tracks
// identity by the CANVAS ITEM's own stable id, recorded in rollbackData
// across deploys.
//
// NOTE: these mappings only take effect when the separate NAT Outbound Mode
// config type is set to "Hybrid" or "Advanced" — "Automatic" ignores them
// entirely (verified: RESTAPI/Models/OutboundNATMode.inc's help text).
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { isValidCidr, looksLikeToken } from '../lib/pfsenseShared'
import type { OutboundNatMapping } from '../../lib/pfsenseApi'

/**
 * `source`/`destination` on OutboundNATMapping are STRICTER than a regular
 * firewall-rule filter address: `allow_ipaddr: false` (verified) — a bare IP
 * with no subnet mask is rejected; only a subnet CIDR, an existing alias, an
 * interface name (optionally suffixed `:ip`), `any`, or (`source` only)
 * `(self)` are accepted. `destination` additionally allows a `!` invert
 * prefix (verified `allow_invert: true`); `source` does not.
 */
export function isValidMappingNetwork(value: string, opts: { allowSelf?: boolean; allowInvert?: boolean } = {}): boolean {
  if (!value) return false
  const hasInvert = opts.allowInvert === true && value.startsWith('!')
  const base = hasInvert ? value.slice(1) : value
  if (!base) return false
  if (base === 'any') return true
  if (opts.allowSelf && base === '(self)') return true
  if (isValidCidr(base)) return true
  const withoutIpSuffix = base.endsWith(':ip') ? base.slice(0, -3) : base
  return looksLikeToken(withoutIpSuffix, 64)
}

export const MAX_DESCRIPTION_LENGTH = 1024

/** `protocol` choices verified against OutboundNATMapping.inc — empty string here means "any" (null on the wire). */
export const PROTOCOLS = ['', 'tcp', 'udp', 'tcp/udp', 'icmp', 'esp', 'ah', 'gre', 'ipv6', 'igmp', 'pim', 'ospf']
const PORT_APPLICABLE_PROTOCOLS = new Set(['tcp', 'udp', 'tcp/udp'])

export interface OutboundMappingSpec {
  itemId: string
  interface: string
  protocol: string
  disabled: boolean
  nonat: boolean
  source: string
  sourcePort: string
  destination: string
  destinationPort: string
  target: string
  targetSubnet: number
  staticNatPort: boolean
  natPort: string
  descr: string
  /** 0-based GLOBAL index into pfSense's `nat/outbound/rule` list. Null = don't touch placement — see lib/pfsenseApi.ts's ordering doc. */
  position: number | null
}

function parsePosition(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export function specFromItem(item: CanvasItemSnapshot): OutboundMappingSpec {
  const f = item.fields ?? {}
  const rawProtocol = String(f.protocol ?? '').trim()
  return {
    itemId: item.id ?? item.name,
    interface: String(f.interface ?? '').trim(),
    // Passed through as-is (not filtered) so validate.ts can flag an
    // unrecognized value as an error instead of it being silently coerced.
    protocol: rawProtocol,
    disabled: f.disabled === true,
    nonat: f.nonat === true,
    source: String(f.source ?? '').trim(),
    sourcePort: String(f.source_port ?? '').trim(),
    destination: String(f.destination ?? '').trim(),
    destinationPort: String(f.destination_port ?? '').trim(),
    target: String(f.target ?? '').trim(),
    targetSubnet: Number.isInteger(Number(f.target_subnet)) ? Number(f.target_subnet) : 128,
    staticNatPort: f.static_nat_port === true,
    natPort: String(f.nat_port ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
    position: parsePosition(f.position),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): OutboundMappingSpec[] {
  return items.map(specFromItem)
}

export function portsApplicable(protocol: string): boolean {
  return PORT_APPLICABLE_PROTOCOLS.has(protocol)
}

export function toOutboundMappingCreateBody(spec: OutboundMappingSpec): Omit<OutboundNatMapping, 'id'> {
  return {
    interface: spec.interface,
    protocol: spec.protocol || null,
    disabled: spec.disabled,
    nonat: spec.nonat,
    source: spec.source,
    source_port: portsApplicable(spec.protocol) && spec.sourcePort ? spec.sourcePort : null,
    destination: spec.destination,
    destination_port: portsApplicable(spec.protocol) && spec.destinationPort ? spec.destinationPort : null,
    target: spec.nonat ? undefined : spec.target,
    target_subnet: spec.nonat ? undefined : spec.targetSubnet,
    static_nat_port: spec.nonat ? false : spec.staticNatPort,
    nat_port: spec.nonat || spec.staticNatPort ? '' : spec.natPort,
    descr: spec.descr,
  }
}

export function toOutboundMappingUpdateBody(spec: OutboundMappingSpec): Omit<OutboundNatMapping, 'id'> {
  return toOutboundMappingCreateBody(spec)
}

export function snapshotOutboundMapping(live: OutboundNatMapping): Omit<OutboundNatMapping, 'id'> {
  return {
    interface: live.interface,
    protocol: live.protocol ?? null,
    disabled: live.disabled ?? false,
    nonat: live.nonat ?? false,
    source: live.source,
    source_port: live.source_port ?? null,
    destination: live.destination,
    destination_port: live.destination_port ?? null,
    target: live.target,
    target_subnet: live.target_subnet,
    static_nat_port: live.static_nat_port ?? false,
    nat_port: live.nat_port ?? '',
    descr: live.descr ?? '',
  }
}
