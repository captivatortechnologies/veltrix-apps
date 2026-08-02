// =============================================================================
// Shared helpers for the Cisco Meraki Appliance VLANs config type.
//
// A VLAN is a PER-OBJECT resource whose id is CALLER-CHOSEN (1-4094), not
// server-assigned — unlike group policies. This makes it the same upsert-by-id
// shape as Cribl's Sources/Destinations: list, find by id, PUT (update) or
// POST (create). Only the well-known scalar fields (id, name, subnet,
// applianceIp, groupPolicyId, vpnNatSubnet, the DHCP settings) are flattened
// into typed canvas fields; the long tail (fixedIpAssignments,
// reservedIpRanges, dhcpOptions, mandatoryDhcp, ipv6, sgt, vrf, uplinks,
// templateVlanType, cidr, mask) is authored as one JSON blob (`advanced`) and
// merged in — the same `{ typed fields, ...advanced }` shape used by group
// policies, with the typed fields always winning on a key collision.
//
// IMPORTANT — VLANs must be ENABLED on a network (`PUT
// .../appliance/vlans/settings { vlansEnabled: true }`) before any per-VLAN
// CRUD below will succeed; an MX ships in single-LAN mode by default. This app
// does not flip that switch automatically — see deploy.ts.
//
// NOTE: schema follows the documented Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/create-network-appliance-vlan/,
// https://developer.cisco.com/meraki/api-v1/get-network-appliance-vlans/).
// Verify against a live Meraki organization.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { networkIdKey, parseJsonObject } from '../../lib/merakiCommon'

export { networkIdKey, parseJsonObject }

/** `dhcpHandling` enum values, as documented on createNetworkApplianceVlan. */
export const DHCP_HANDLING_VALUES = ['Run a DHCP server', 'Relay DHCP to another server', 'Do not respond to DHCP requests'] as const
/** `dhcpLeaseTime` enum values, as documented on createNetworkApplianceVlan. */
export const DHCP_LEASE_TIME_VALUES = ['30 minutes', '1 hour', '4 hours', '12 hours', '1 day', '1 week'] as const

/** A caller-chosen VLAN id must be an integer string in [1, 4094]. */
export const VLAN_ID_RE = /^[0-9]{1,4}$/
export function isValidVlanId(id: string): boolean {
  if (!VLAN_ID_RE.test(id)) return false
  const n = Number(id)
  return Number.isInteger(n) && n >= 1 && n <= 4094
}

/** A VLAN as Meraki returns/accepts it. Loosely typed — `advanced` fields and read-only fields (e.g. `interfaceId`) pass through untyped. */
export interface MerakiVlan {
  id?: string
  networkId?: string
  name?: string
  [key: string]: unknown
}

/** Identity keys never taken from the `advanced` JSON blob — they come from typed fields, or are read-only. */
export const IGNORED_ADVANCED_KEYS = ['id', 'networkId', 'interfaceId'] as const

export function stripIgnoredAdvancedKeys(advanced: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...advanced }
  for (const key of IGNORED_ADVANCED_KEYS) delete copy[key]
  return copy
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface VlanSpec {
  itemName: string
  networkId: string
  id: string
  name: string
  groupPolicyId: string
  subnet: string
  applianceIp: string
  vpnNatSubnet: string
  dhcpHandling: string
  dhcpLeaseTime: string
  dnsNameservers: string
  dhcpRelayServerIps: string[]
  dhcpBootOptionsEnabled: boolean
  dhcpBootNextServer: string
  dhcpBootFilename: string
  advancedRaw: unknown
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Each canvas item describes one VLAN in one Meraki network. */
export function extractVlanSpecs(canvas: CanvasSnapshot): VlanSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      networkId: str(fields.network_id),
      id: str(fields.id),
      name: str(fields.name),
      groupPolicyId: str(fields.group_policy_id),
      subnet: str(fields.subnet),
      applianceIp: str(fields.appliance_ip),
      vpnNatSubnet: str(fields.vpn_nat_subnet),
      dhcpHandling: str(fields.dhcp_handling),
      dhcpLeaseTime: str(fields.dhcp_lease_time),
      dnsNameservers: str(fields.dns_nameservers),
      dhcpRelayServerIps: strList(fields.dhcp_relay_server_ips),
      dhcpBootOptionsEnabled: readBool(fields.dhcp_boot_options_enabled, false),
      dhcpBootNextServer: str(fields.dhcp_boot_next_server),
      dhcpBootFilename: str(fields.dhcp_boot_filename),
      advancedRaw: fields.advanced,
    }
  })
}

/** The typed (flattened) fields for a spec, omitting anything left blank. */
export function typedVlanFields(spec: VlanSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { name: spec.name }
  if (spec.groupPolicyId) out.groupPolicyId = spec.groupPolicyId
  if (spec.subnet) out.subnet = spec.subnet
  if (spec.applianceIp) out.applianceIp = spec.applianceIp
  if (spec.vpnNatSubnet) out.vpnNatSubnet = spec.vpnNatSubnet
  if (spec.dhcpHandling) out.dhcpHandling = spec.dhcpHandling
  if (spec.dhcpLeaseTime) out.dhcpLeaseTime = spec.dhcpLeaseTime
  if (spec.dnsNameservers) out.dnsNameservers = spec.dnsNameservers
  if (spec.dhcpRelayServerIps.length > 0) out.dhcpRelayServerIps = spec.dhcpRelayServerIps
  if (spec.dhcpBootOptionsEnabled) out.dhcpBootOptionsEnabled = spec.dhcpBootOptionsEnabled
  if (spec.dhcpBootNextServer) out.dhcpBootNextServer = spec.dhcpBootNextServer
  if (spec.dhcpBootFilename) out.dhcpBootFilename = spec.dhcpBootFilename
  return out
}

/**
 * Build a VLAN request body: `advanced` JSON spread first, then the typed
 * fields (always win on a key collision), matching the group-policies
 * precedent. `includeId` controls whether the caller-chosen VLAN id is
 * included — true for create (POST body needs it), false for update (PUT
 * takes it from the URL path only, per the documented schema).
 */
export function buildVlanBody(spec: VlanSpec, advanced: Record<string, unknown>, includeId: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { ...stripIgnoredAdvancedKeys(advanced), ...typedVlanFields(spec) }
  if (includeId) body.id = spec.id
  return body
}

/** The keys we declare on a VLAN (typed fields + advanced keys, minus identity/read-only) — used to scope drift comparison. */
export function declaredVlanKeys(spec: VlanSpec, advanced: Record<string, unknown>): string[] {
  return Object.keys({ ...stripIgnoredAdvancedKeys(advanced), ...typedVlanFields(spec) })
}

/**
 * Rebuild a PUT restore body from a captured prior live VLAN object (as
 * returned by GET): strips the identity / read-only keys (`id`, `networkId`,
 * `interfaceId`) that the update schema excludes, keeping everything else
 * verbatim.
 */
export function restoreVlanBody(prior: MerakiVlan): Record<string, unknown> {
  return stripIgnoredAdvancedKeys(prior)
}
