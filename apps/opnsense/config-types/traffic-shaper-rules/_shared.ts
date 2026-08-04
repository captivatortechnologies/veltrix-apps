// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense
// traffic-shaper-rules config type (`/api/trafficshaper/settings/*Rule`,
// `/api/trafficshaper/service/reconfigure` — see lib/trafficShaperApi.ts's
// module doc). No meaningful OPNsense version floor. This is TrafficShaper's
// OWN `rules.rule` node — a DIFFERENT model than Firewall's `rules.rule`
// (see lib/trafficShaperApi.ts vs lib/filterRuleApi.ts).
//
// IDENTITY: unlike pipes/queues, `description` on a shaper rule is NOT
// required by the model (verified in TrafficShaper.xml — no <Required>Y</Required>
// on `rules.rule.description`), so — like firewall-rules/source-nat/
// one-to-one-nat — this app reconciles by the CANVAS ITEM's own stable
// `itemId`, and REQUIRES description in its OWN canvas purely for a human
// label.
//
// REFERENCE: `target` is a ModelRelationField pointing at EITHER a
// `pipes.pipe` OR a `queues.queue` uuid, both displayed/matched by their own
// description — this config type declares the target by NAME and searches
// BOTH resources to resolve it, the same "search multiple candidate
// resources" pattern as this app's `references` concept elsewhere.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { LiveShaperRule, ShaperRuleBody } from '../../lib/trafficShaperApi'

export const PROTOCOLS = ['ip', 'ip4', 'ip6', 'udp', 'tcp', 'tcp_ack', 'tcp_ack_not', 'icmp', 'ipv6-icmp', 'igmp', 'esp', 'ah', 'gre'] as const
export const DIRECTIONS = ['', 'in', 'out'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
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

export interface ShaperRuleSpec {
  /** The canvas item's own stable id — the TRUE identity for reconcile (see module doc). Falls back to item.name for test fixtures that omit id. */
  itemId: string
  description: string
  enabled: boolean
  sequence: number
  interfaceName: string
  interface2: string
  proto: string
  source: string[]
  sourceNot: boolean
  srcPort: string
  destination: string[]
  destinationNot: boolean
  dstPort: string
  dscp: string[]
  direction: string
  targetName: string
}

export function extractShaperRuleSpecs(canvas: CanvasSnapshot): ShaperRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id ?? item.name,
      description: asString(f.description),
      enabled: asBool(f.enabled, true),
      sequence: typeof f.sequence === 'number' && Number.isFinite(f.sequence) ? f.sequence : 1,
      interfaceName: asString(f.interface) || 'wan',
      interface2: asString(f.interface2),
      proto: asString(f.proto) || 'ip',
      source: strList(f.source).length > 0 ? strList(f.source) : ['any'],
      sourceNot: asBool(f.source_not, false),
      srcPort: asString(f.src_port) || 'any',
      destination: strList(f.destination).length > 0 ? strList(f.destination) : ['any'],
      destinationNot: asBool(f.destination_not, false),
      dstPort: asString(f.dst_port) || 'any',
      dscp: strList(f.dscp),
      direction: asString(f.direction),
      targetName: asString(f.target_name),
    }
  })
}

/** Build the addRule/setRule body. `targetUuid` is the already-resolved (name -> uuid) pipe-or-queue reference. */
export function buildShaperRuleBody(spec: ShaperRuleSpec, targetUuid: string): ShaperRuleBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    sequence: String(spec.sequence),
    interface: spec.interfaceName,
    interface2: spec.interface2,
    proto: spec.proto,
    iplen: '',
    source: spec.source.join(','),
    source_not: spec.sourceNot ? '1' : '0',
    src_port: spec.srcPort,
    destination: spec.destination.join(','),
    destination_not: spec.destinationNot ? '1' : '0',
    dst_port: spec.dstPort,
    dscp: spec.dscp.join(','),
    direction: spec.direction,
    target: targetUuid,
    description: spec.description,
  }
}

export function snapshotLive(live: LiveShaperRule): ShaperRuleBody {
  return {
    enabled: String(live.enabled ?? '1'),
    sequence: String(live.sequence ?? '1'),
    interface: String(live.interface ?? 'wan'),
    interface2: String(live.interface2 ?? ''),
    proto: String(live.proto ?? 'ip'),
    iplen: String(live.iplen ?? ''),
    source: String(live.source ?? 'any'),
    source_not: String(live.source_not ?? '0'),
    src_port: String(live.src_port ?? 'any'),
    destination: String(live.destination ?? 'any'),
    destination_not: String(live.destination_not ?? '0'),
    dst_port: String(live.dst_port ?? 'any'),
    dscp: String(live.dscp ?? ''),
    direction: String(live.direction ?? ''),
    target: String(live.target ?? ''),
    description: String(live.description ?? ''),
  }
}

export function isValidProtocol(value: string): boolean {
  return (PROTOCOLS as readonly string[]).includes(value)
}
export function isValidDirection(value: string): boolean {
  return (DIRECTIONS as readonly string[]).includes(value)
}
