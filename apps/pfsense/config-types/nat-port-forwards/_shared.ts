// =============================================================================
// Shared helpers for the NAT Port Forwards config type (validate + deploy +
// rollback + drift). Field shapes verified against RESTAPI/Models/PortForward.inc
// — see lib/pfsenseApi.ts's module doc for the ordering/apply citations.
//
// IDENTITY: like firewall-rules (see that config type's _shared.ts doc),
// pfSense NAT port forwards have no unique/name field (verified — `descr` is
// free-text, not unique). This config type therefore ALSO tracks identity by
// the CANVAS ITEM's own stable id, recorded in rollbackData across deploys.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { PortForward } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024

export type IpProtocol = 'inet' | 'inet6' | 'inet46'
export const IP_PROTOCOLS: IpProtocol[] = ['inet', 'inet6', 'inet46']

/** `protocol` choices verified against PortForward.inc — 'any' is a real accepted value here (unlike firewall-rules, where "any" is represented as an empty/null protocol). */
export const PROTOCOLS = ['any', 'tcp', 'udp', 'tcp/udp', 'icmp', 'esp', 'ah', 'gre', 'ipv6', 'igmp', 'pim', 'ospf']
const PORT_APPLICABLE_PROTOCOLS = new Set(['tcp', 'udp', 'tcp/udp'])

export type NatReflection = 'enable' | 'disable' | 'purenat' | ''
export const NAT_REFLECTIONS: NatReflection[] = ['', 'enable', 'disable', 'purenat']

/** `associated_rule_id`'s special keywords, verified against PortForward.inc's ForeignModelField. */
export const ASSOCIATED_RULE_KEYWORDS = ['', 'new', 'pass'] as const

/** One NAT port forward item, normalized from canvas fields. `itemId` IS this port forward's identity — see module doc. */
export interface PortForwardSpec {
  itemId: string
  interface: string
  ipprotocol: IpProtocol
  protocol: string
  source: string
  sourcePort: string
  destination: string
  destinationPort: string
  target: string
  localPort: string
  disabled: boolean
  nordr: boolean
  nosync: boolean
  descr: string
  natreflection: NatReflection
  associatedRuleId: string
  /** 0-based GLOBAL index into pfSense's `nat/rule` list. Null = don't touch placement — see lib/pfsenseApi.ts's ordering doc. */
  position: number | null
}

function parsePosition(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Read one canvas item's fields into a normalized port-forward spec. `itemId` falls back to `item.name` only for test fixtures that omit `id`. */
export function specFromItem(item: CanvasItemSnapshot): PortForwardSpec {
  const f = item.fields ?? {}
  const rawIpprotocol = String(f.ipprotocol ?? 'inet').trim()
  const rawNatReflection = String(f.natreflection ?? '').trim()
  return {
    itemId: item.id ?? item.name,
    interface: String(f.interface ?? '').trim(),
    ipprotocol: (IP_PROTOCOLS as string[]).includes(rawIpprotocol) ? (rawIpprotocol as IpProtocol) : 'inet',
    // Passed through as-is (not filtered) so validate.ts can flag an
    // unrecognized value as an error instead of it being silently coerced.
    protocol: String(f.protocol ?? '').trim(),
    source: String(f.source ?? '').trim(),
    sourcePort: String(f.source_port ?? '').trim(),
    destination: String(f.destination ?? '').trim(),
    destinationPort: String(f.destination_port ?? '').trim(),
    target: String(f.target ?? '').trim(),
    localPort: String(f.local_port ?? '').trim(),
    disabled: f.disabled === true,
    nordr: f.nordr === true,
    nosync: f.nosync === true,
    descr: String(f.descr ?? '').trim(),
    natreflection: (NAT_REFLECTIONS as string[]).includes(rawNatReflection) ? (rawNatReflection as NatReflection) : '',
    associatedRuleId: String(f.associated_rule_id ?? '').trim(),
    position: parsePosition(f.position),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): PortForwardSpec[] {
  return items.map(specFromItem)
}

/** Whether `protocol` puts source/destination ports in scope (mirrors the API's own `conditions`). */
export function portsApplicable(protocol: string): boolean {
  return PORT_APPLICABLE_PROTOCOLS.has(protocol)
}

/** The full create-request body for a spec (POST). */
export function toPortForwardCreateBody(spec: PortForwardSpec): Omit<PortForward, 'id'> {
  return {
    interface: spec.interface,
    ipprotocol: spec.ipprotocol,
    protocol: spec.protocol,
    source: spec.source,
    source_port: portsApplicable(spec.protocol) && spec.sourcePort ? spec.sourcePort : null,
    destination: spec.destination,
    destination_port: portsApplicable(spec.protocol) && spec.destinationPort ? spec.destinationPort : null,
    target: spec.target,
    local_port: spec.localPort,
    disabled: spec.disabled,
    nordr: spec.nordr,
    nosync: spec.nosync,
    descr: spec.descr,
    natreflection: spec.natreflection || null,
    associated_rule_id: spec.associatedRuleId,
  }
}

/** The PATCH request body for a spec. Every PortForward field is editable (no immutable field like alias `name` or rule `floating`). */
export function toPortForwardUpdateBody(spec: PortForwardSpec): Omit<PortForward, 'id'> {
  return toPortForwardCreateBody(spec)
}

/** Snapshot a live port forward's managed fields for rollback. */
export function snapshotPortForward(live: PortForward): Omit<PortForward, 'id'> {
  return {
    interface: live.interface,
    ipprotocol: live.ipprotocol ?? 'inet',
    protocol: live.protocol,
    source: live.source,
    source_port: live.source_port ?? null,
    destination: live.destination,
    destination_port: live.destination_port ?? null,
    target: live.target,
    local_port: live.local_port,
    disabled: live.disabled ?? false,
    nordr: live.nordr ?? false,
    nosync: live.nosync ?? false,
    descr: live.descr ?? '',
    natreflection: live.natreflection ?? null,
    associated_rule_id: live.associated_rule_id ?? '',
  }
}
