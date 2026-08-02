// =============================================================================
// Shared helpers for the Firewall Rules config type (validate + deploy +
// rollback + drift). Field shapes verified against RESTAPI/Models/FirewallRule.inc
// — see lib/pfsenseApi.ts's module doc for the full field-scope and ordering
// citations.
//
// IDENTITY: pfSense firewall rules have no unique/name field (verified —
// `descr` is free-text, not `unique: true`, unlike FirewallAlias.name or
// VirtualIP.subnet). This config type therefore tracks identity by the
// CANVAS ITEM's own stable id (CanvasItemSnapshot.id), recorded in
// rollbackData across deploys — see deploy.ts's module doc.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { FirewallRule } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024

export type RuleAction = 'pass' | 'block' | 'reject'
export const RULE_ACTIONS: RuleAction[] = ['pass', 'block', 'reject']

export type IpProtocol = 'inet' | 'inet6' | 'inet46'
export const IP_PROTOCOLS: IpProtocol[] = ['inet', 'inet6', 'inet46']

/** `protocol` choices verified against FirewallRule.inc — empty string here means "any" (null on the wire). */
export const PROTOCOLS = ['', 'tcp', 'udp', 'tcp/udp', 'icmp', 'esp', 'ah', 'gre', 'ipv6', 'igmp', 'pim', 'ospf', 'carp', 'pfsync']
const PORT_APPLICABLE_PROTOCOLS = new Set(['tcp', 'udp', 'tcp/udp'])

export type Direction = 'any' | 'in' | 'out'
export const DIRECTIONS: Direction[] = ['any', 'in', 'out']

export type StateType = 'keep state' | 'sloppy state' | 'synproxy state' | 'none'
export const STATE_TYPES: StateType[] = ['keep state', 'sloppy state', 'synproxy state', 'none']

/** One firewall rule item, normalized from canvas fields. `itemId` IS this rule's identity — see module doc. */
export interface RuleSpec {
  itemId: string
  type: RuleAction | ''
  interfaces: string[]
  floating: boolean
  ipprotocol: IpProtocol | ''
  protocol: string
  source: string
  sourcePort: string
  destination: string
  destinationPort: string
  descr: string
  disabled: boolean
  log: boolean
  direction: Direction
  quick: boolean
  statetype: StateType
  /** 0-based GLOBAL index into pfSense's rule list — see lib/pfsenseApi.ts's ordering doc. Null = don't touch placement. */
  position: number | null
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

function parsePosition(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** Read one canvas item's fields into a normalized rule spec. `itemId` falls back to `item.name` only for test fixtures that omit `id`. */
export function specFromItem(item: CanvasItemSnapshot): RuleSpec {
  const f = item.fields ?? {}
  const rawType = String(f.type ?? '').trim()
  const rawIpprotocol = String(f.ipprotocol ?? '').trim()
  const rawStatetype = String(f.statetype ?? '').trim()
  const rawDirection = String(f.direction ?? 'any').trim()
  const rawProtocol = String(f.protocol ?? '').trim()
  return {
    itemId: item.id ?? item.name,
    type: (RULE_ACTIONS as string[]).includes(rawType) ? (rawType as RuleAction) : '',
    interfaces: strList(f.interface),
    floating: f.floating === true,
    ipprotocol: (IP_PROTOCOLS as string[]).includes(rawIpprotocol) ? (rawIpprotocol as IpProtocol) : '',
    // Passed through as-is (not filtered against PROTOCOLS) so validate.ts
    // can flag an unrecognized value as an error instead of it silently
    // becoming "any".
    protocol: rawProtocol,
    source: String(f.source ?? '').trim(),
    sourcePort: String(f.source_port ?? '').trim(),
    destination: String(f.destination ?? '').trim(),
    destinationPort: String(f.destination_port ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
    disabled: f.disabled === true,
    log: f.log === true,
    direction: (DIRECTIONS as string[]).includes(rawDirection) ? (rawDirection as Direction) : 'any',
    quick: f.quick === true,
    statetype: (STATE_TYPES as string[]).includes(rawStatetype) ? (rawStatetype as StateType) : 'keep state',
    position: parsePosition(f.position),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): RuleSpec[] {
  return items.map(specFromItem)
}

/** Whether `protocol` puts source/destination ports in scope (mirrors the API's own `conditions`). */
export function portsApplicable(protocol: string): boolean {
  return PORT_APPLICABLE_PROTOCOLS.has(protocol)
}

/** The full create-request body for a spec (POST). */
export function toRuleCreateBody(spec: RuleSpec): Omit<FirewallRule, 'id'> {
  return {
    type: spec.type as RuleAction,
    interface: spec.interfaces,
    floating: spec.floating,
    ipprotocol: spec.ipprotocol as IpProtocol,
    protocol: spec.protocol || null,
    source: spec.source,
    source_port: portsApplicable(spec.protocol) && spec.sourcePort ? spec.sourcePort : null,
    destination: spec.destination,
    destination_port: portsApplicable(spec.protocol) && spec.destinationPort ? spec.destinationPort : null,
    descr: spec.descr,
    disabled: spec.disabled,
    log: spec.log,
    quick: spec.floating ? spec.quick : false,
    direction: spec.floating ? spec.direction : 'any',
    statetype: spec.statetype,
  }
}

/** The PATCH request body for a spec — `floating` is OMITTED (immutable, see FirewallRule doc). */
export function toRuleUpdateBody(spec: RuleSpec): Omit<FirewallRule, 'id' | 'floating'> {
  const { floating: _floating, ...rest } = toRuleCreateBody(spec)
  return rest
}

/** Snapshot a live rule's managed fields for rollback (everything PATCH/rollback can restore, i.e. never `floating`). */
export function snapshotRule(live: FirewallRule): Omit<FirewallRule, 'id' | 'floating'> {
  return {
    type: live.type,
    interface: Array.isArray(live.interface) ? live.interface : [],
    ipprotocol: live.ipprotocol,
    protocol: live.protocol ?? null,
    source: live.source,
    source_port: live.source_port ?? null,
    destination: live.destination,
    destination_port: live.destination_port ?? null,
    descr: live.descr ?? '',
    disabled: live.disabled ?? false,
    log: live.log ?? false,
    quick: live.quick ?? false,
    direction: live.direction ?? 'any',
    statetype: live.statetype ?? 'keep state',
  }
}
