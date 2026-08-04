// =============================================================================
// Shared types/validation for Cisco Meraki One-to-One NAT Rules.
//
// Ordered-whole-list-per-network shape — see lib/merakiOrderedList.ts for the
// deploy/rollback/driftDetect/healthCheck engine this config type is a thin
// wrapper over (network_id + comment + rules canvas shape, GET/PUT `{ rules }`).
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-one-to-one-nat-rules/).
// Verify against a live Meraki organization.
// =============================================================================

import { canonicalJson, looksLikeKnownNetworkId, networkIdKey } from '../../lib/merakiCommon'

export { canonicalJson, looksLikeKnownNetworkId, networkIdKey }

/** `allowedInbound[].protocol` enum, as documented. */
export const NAT_INBOUND_PROTOCOLS = ['tcp', 'udp', 'icmp-ping', 'any'] as const
/** Meraki's WAN uplink naming for this endpoint: "internetN". */
export const UPLINK_RE = /^internet[0-9]+$/

export interface OneToOneNatAllowedInbound {
  protocol: string
  destinationPorts: string[]
  allowedIps: string[]
}

export interface MerakiOneToOneNatRule {
  name?: string
  publicIp?: string
  lanIp: string
  uplink?: string
  allowedInbound?: OneToOneNatAllowedInbound[]
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean) : []
}

/** Normalize one parsed rule: trims scalars, coerces allowedInbound into a clean array. Does not validate. */
export function normalizeOneToOneNatRule(rule: Partial<MerakiOneToOneNatRule> | null | undefined): MerakiOneToOneNatRule {
  const r = rule ?? {}
  return {
    name: typeof r.name === 'string' ? r.name.trim() : '',
    publicIp: typeof r.publicIp === 'string' ? r.publicIp.trim() : '',
    lanIp: typeof r.lanIp === 'string' ? r.lanIp.trim() : '',
    uplink: typeof r.uplink === 'string' ? r.uplink.trim() : '',
    allowedInbound: Array.isArray(r.allowedInbound)
      ? r.allowedInbound.map((ib) => ({
          protocol: typeof ib?.protocol === 'string' ? ib.protocol.trim().toLowerCase() : '',
          destinationPorts: strArray(ib?.destinationPorts),
          allowedIps: strArray(ib?.allowedIps),
        }))
      : [],
  }
}
