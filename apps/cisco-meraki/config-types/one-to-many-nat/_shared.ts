// =============================================================================
// Shared types/validation for Cisco Meraki One-to-Many NAT Rules.
//
// Ordered-whole-list-per-network shape — see lib/merakiOrderedList.ts.
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-one-to-many-nat-rules/).
// Verify against a live Meraki organization.
// =============================================================================

import { canonicalJson, looksLikeKnownNetworkId, networkIdKey } from '../../lib/merakiCommon'

export { canonicalJson, looksLikeKnownNetworkId, networkIdKey }

/** `portRules[].protocol` enum, as documented. */
export const PORT_RULE_PROTOCOLS = ['tcp', 'udp'] as const
/** Meraki's WAN uplink naming for this endpoint: "internetN". */
export const UPLINK_RE = /^internet[0-9]+$/

export interface OneToManyPortRule {
  name?: string
  protocol: string
  publicPort: string
  localIp: string
  localPort: string
  allowedIps: string[]
}

export interface MerakiOneToManyNatRule {
  publicIp: string
  uplink: string
  portRules: OneToManyPortRule[]
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean) : []
}

/** Normalize one parsed rule: trims scalars, coerces portRules into a clean array. Does not validate. */
export function normalizeOneToManyNatRule(rule: Partial<MerakiOneToManyNatRule> | null | undefined): MerakiOneToManyNatRule {
  const r = rule ?? {}
  return {
    publicIp: typeof r.publicIp === 'string' ? r.publicIp.trim() : '',
    uplink: typeof r.uplink === 'string' ? r.uplink.trim() : '',
    portRules: Array.isArray(r.portRules)
      ? r.portRules.map((pr) => ({
          name: typeof pr?.name === 'string' ? pr.name.trim() : '',
          protocol: typeof pr?.protocol === 'string' ? pr.protocol.trim().toLowerCase() : '',
          publicPort: typeof pr?.publicPort === 'string' ? pr.publicPort.trim() : '',
          localIp: typeof pr?.localIp === 'string' ? pr.localIp.trim() : '',
          localPort: typeof pr?.localPort === 'string' ? pr.localPort.trim() : '',
          allowedIps: strArray(pr?.allowedIps),
        }))
      : [],
  }
}
