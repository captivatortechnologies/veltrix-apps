// =============================================================================
// Shared helpers for the Virtual IPs config type (validate + deploy +
// rollback + drift). Field shapes verified against RESTAPI/Models/VirtualIP.inc
// — see lib/pfsenseApi.ts's module doc for the SEPARATE apply-endpoint
// citation (virtual IPs are NOT part of the shared /api/v2/firewall/apply
// subsystem list).
//
// IDENTITY: unlike firewall-rules/nat-port-forwards, VirtualIP DOES declare a
// natural unique field — `subnet` (`unique: true`, verified) — the VIP's own
// address, which can obviously never collide with another VIP. This config
// type therefore matches firewall-aliases' pattern (match live objects by
// this natural key) rather than the itemId-tracking pattern.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import { isValidIp } from '../lib/pfsenseShared'
import type { VirtualIP } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024

export type VipMode = 'ipalias' | 'proxyarp' | 'carp' | 'other'
export const VIP_MODES: VipMode[] = ['ipalias', 'proxyarp', 'carp', 'other']

export type VipType = 'single' | 'network'
export const VIP_TYPES: VipType[] = ['single', 'network']

export type CarpMode = 'mcast' | 'ucast'
export const CARP_MODES: CarpMode[] = ['mcast', 'ucast']

/** One virtual IP item, normalized from canvas fields. `subnet` IS this VIP's identity — see module doc. */
export interface VirtualIpSpec {
  itemId?: string
  mode: VipMode | ''
  interface: string
  type: VipType
  subnet: string
  subnetBits: number | null
  descr: string
  noexpand: boolean
  vhid: number | null
  advbase: number
  advskew: number
  password: string
  carpMode: CarpMode
  carpPeer: string
}

function parseIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

/** Read one canvas item's fields into a normalized virtual-IP spec. */
export function specFromItem(item: CanvasItemSnapshot): VirtualIpSpec {
  const f = item.fields ?? {}
  const rawMode = String(f.mode ?? '').trim()
  const rawType = String(f.type ?? 'single').trim()
  const rawCarpMode = String(f.carp_mode ?? 'mcast').trim()
  return {
    itemId: item.id,
    mode: (VIP_MODES as string[]).includes(rawMode) ? (rawMode as VipMode) : '',
    interface: String(f.interface ?? '').trim(),
    type: (VIP_TYPES as string[]).includes(rawType) ? (rawType as VipType) : 'single',
    subnet: String(f.subnet ?? '').trim(),
    subnetBits: parseIntOrNull(f.subnet_bits),
    descr: String(f.descr ?? '').trim(),
    noexpand: f.noexpand === true,
    vhid: parseIntOrNull(f.vhid),
    advbase: parseIntOrNull(f.advbase) ?? 1,
    advskew: parseIntOrNull(f.advskew) ?? 0,
    password: String(f.password ?? ''),
    carpMode: (CARP_MODES as string[]).includes(rawCarpMode) ? (rawCarpMode as CarpMode) : 'mcast',
    carpPeer: String(f.carp_peer ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): VirtualIpSpec[] {
  return items.map(specFromItem)
}

/** VIP identity — the `subnet` address (unique per the model), trimmed. IPs are not case-sensitive but are compared as literal strings (no normalization of e.g. IPv6 compression forms). */
export function vipKey(subnet: string): string {
  return subnet.trim()
}

/** The full create/update request body for a spec. Every VirtualIP field is editable (no immutable field like alias `name`). */
export function toVirtualIpBody(spec: VirtualIpSpec): Omit<VirtualIP, 'id'> {
  const isCarp = spec.mode === 'carp'
  const body: Omit<VirtualIP, 'id'> = {
    mode: spec.mode as VipMode,
    interface: spec.interface,
    type: spec.type,
    subnet: spec.subnet,
    subnet_bits: spec.subnetBits ?? 24,
    descr: spec.descr,
  }
  if (spec.mode === 'proxyarp' || spec.mode === 'other') {
    body.noexpand = spec.noexpand
  }
  if (isCarp) {
    body.vhid = spec.vhid ?? undefined
    body.advbase = spec.advbase
    body.advskew = spec.advskew
    body.password = spec.password
    body.carp_mode = spec.carpMode
    if (spec.carpMode === 'ucast') body.carp_peer = spec.carpPeer
  }
  return body
}

/** Snapshot a live virtual IP's managed fields for rollback (excludes read-only `carp_status`/`uniqid`). */
export function snapshotVirtualIp(live: VirtualIP): Omit<VirtualIP, 'id' | 'subnet'> {
  return {
    mode: live.mode,
    interface: live.interface,
    type: live.type ?? 'single',
    subnet_bits: live.subnet_bits,
    descr: live.descr ?? '',
    noexpand: live.noexpand ?? false,
    vhid: live.vhid,
    advbase: live.advbase,
    advskew: live.advskew,
    // `password` is write-only-in-spirit (CARP shared secret) — the REST API
    // package does not echo it back in a GET/list representation the same
    // way, so a restored rollback for a CARP VIP may need the password
    // re-entered; not silently fabricated here.
    carp_mode: live.carp_mode,
    carp_peer: live.carp_peer,
  }
}

/** IPv4/IPv6 address only — VirtualIP.subnet is validated with IPAddressValidator, no CIDR notation on this field (the mask is the separate `subnet_bits` field). */
export function isValidVipSubnet(value: string): boolean {
  return isValidIp(value)
}
