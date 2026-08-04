// =============================================================================
// Shared types/validation for Cisco Meraki Switch Access Control Lists.
//
// Ordered-whole-list-per-network shape — see lib/merakiOrderedList.ts. Unlike
// L3 firewall rules, Meraki documents that an empty `rules` array CLEARS all
// switch ACLs (no implicit default rule) — see validate.ts's
// EMPTY_RULES_CLEARS_ACL warning.
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-switch-access-control-lists/).
// Verify against a live Meraki organization.
// =============================================================================

import { getSwitchAcls, putSwitchAcls } from '../../lib/merakiApi'

/** `policy` enum, as documented. */
export const ACL_POLICIES = ['allow', 'deny'] as const
/** `protocol` enum, as documented. */
export const ACL_PROTOCOLS = ['any', 'tcp', 'udp'] as const
/** `ipVersion` enum, as documented (defaults to "ipv4" when unset — but "any" is also valid). */
export const ACL_IP_VERSIONS = ['any', 'ipv4', 'ipv6'] as const

export interface MerakiSwitchAclRule {
  comment?: string
  policy: string
  ipVersion?: string
  protocol: string
  srcCidr: string
  srcPort: string
  dstCidr: string
  dstPort: string
  vlan?: string
  [key: string]: unknown
}

/** Normalize one parsed rule: trims scalars, lower-cases enums, defaults ipVersion/vlan to "any". Does not validate. */
export function normalizeSwitchAclRule(rule: Partial<MerakiSwitchAclRule> | null | undefined): MerakiSwitchAclRule {
  const r = rule ?? {}
  return {
    comment: String(r.comment ?? '').trim(),
    policy: String(r.policy ?? '').trim().toLowerCase(),
    ipVersion: String(r.ipVersion ?? 'any').trim().toLowerCase(),
    protocol: String(r.protocol ?? '').trim().toLowerCase(),
    srcCidr: String(r.srcCidr ?? '').trim(),
    srcPort: String(r.srcPort ?? 'any').trim(),
    dstCidr: String(r.dstCidr ?? '').trim(),
    dstPort: String(r.dstPort ?? 'any').trim(),
    vlan: String(r.vlan ?? 'any').trim(),
  }
}

export const transport = { get: getSwitchAcls, put: putSwitchAcls, resourceLabel: 'switch access-control lists' }
