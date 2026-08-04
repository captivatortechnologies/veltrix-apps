// =============================================================================
// Shared types/validation for Cisco Meraki Port Forwarding Rules.
//
// Ordered-whole-list-per-network shape — see lib/merakiOrderedList.ts.
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-port-forwarding-rules/).
// Verify against a live Meraki organization.
// =============================================================================

import { canonicalJson, looksLikeKnownNetworkId, networkIdKey } from '../../lib/merakiCommon'

export { canonicalJson, looksLikeKnownNetworkId, networkIdKey }

/** `protocol` enum, as documented. */
export const PORT_FORWARDING_PROTOCOLS = ['tcp', 'udp'] as const
/** `uplink` enum, as documented — richer than the NAT endpoints' "internetN" form. */
export const PORT_FORWARDING_UPLINKS = ['all', 'both', 'internet1', 'internet2', 'internet3', 'internet4'] as const

export interface MerakiPortForwardingRule {
  name?: string
  lanIp: string
  uplink: string
  publicPort: string
  localPort: string
  allowedIps: string[]
  protocol: string
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean) : []
}

/** Normalize one parsed rule: trims scalars, lower-cases protocol. Does not validate. */
export function normalizePortForwardingRule(rule: Partial<MerakiPortForwardingRule> | null | undefined): MerakiPortForwardingRule {
  const r = rule ?? {}
  return {
    name: typeof r.name === 'string' ? r.name.trim() : '',
    lanIp: typeof r.lanIp === 'string' ? r.lanIp.trim() : '',
    uplink: typeof r.uplink === 'string' ? r.uplink.trim() : '',
    publicPort: typeof r.publicPort === 'string' ? r.publicPort.trim() : '',
    localPort: typeof r.localPort === 'string' ? r.localPort.trim() : '',
    allowedIps: strArray(r.allowedIps),
    protocol: typeof r.protocol === 'string' ? r.protocol.trim().toLowerCase() : '',
  }
}
