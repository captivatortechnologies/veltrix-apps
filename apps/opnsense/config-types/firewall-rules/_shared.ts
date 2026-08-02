// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense firewall-rules
// config type (`/api/firewall/filter/*`, REQUIRES OPNsense 24.1+ — see
// lib/opnsenseApi.ts's FILTER_MODULE doc for the full citation trail).
//
// IDENTITY: unlike firewall-aliases/firewall-categories, a pf filter rule has
// NO name field at all (verified: Filter.xml's `rules.rule` — see lib/
// opnsenseApi.ts's LiveFilterRule). This app therefore reconciles by the
// CANVAS ITEM's own stable `itemId` (CanvasItemSnapshot.id — "Always set by
// the platform" per the SDK's own doc) mapped to the OPNsense-assigned
// `uuid`, carried across deploys in rollbackData — the same "audit trail"
// approach this codebase's Akamai network-lists app uses for a resource whose
// natural key (there, list name) can't be trusted to stay put; here there is
// no natural key at all. `description` is REQUIRED by this app's OWN canvas
// (the underlying model does NOT require it) purely so every declared rule
// has a human-readable label in the canvas UI and in messages — it plays NO
// role in matching.
//
// Two real model fields are dropped for v0.2.0, flagged rather than faked:
// `state-policy`, `divert-to`/`gateway`/`replyto`/`disablereplyto`,
// `allowopts`/`nosync`/`nopfsync`, every state-table tuning knob
// (`statetimeout`, `udp-*`, `max*`, `adaptivestart`/`adaptiveend`),
// `overload`, `prio`/`set-prio`/`set-prio-low`, `tag`/`tagged`,
// `tcpflags1`/`tcpflags2`/`tcpflags_any`, `sched` (schedules need their own
// config type), `tos`, and `shaper1`/`shaper2` (traffic-shaper pipe/queue
// relations — a cross-module dependency this app doesn't model). `icmptype`/
// `icmp6type` are also dropped — see README.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { FilterRuleBody, LiveFilterRule } from '../../lib/opnsenseApi'

export const ACTIONS = ['pass', 'block', 'reject'] as const
export const DIRECTIONS = ['in', 'out', 'any'] as const
// "inet46" (any/dual-stack) is EXCLUDED — Filter.xml's own comment marks it
// `/* XXX remove when filter.lib.inc use is removed */`, a deprecation signal
// from the source itself, so this app never offers or writes it.
export const IP_PROTOCOLS = ['inet', 'inet6'] as const
export const STATE_TYPES = ['keep', 'sloppy', 'modulate', 'synproxy', 'none'] as const

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

export interface FilterRuleSpec {
  /** The canvas item's own stable id — the TRUE identity for reconcile (see module doc). Falls back to item.name for test fixtures that omit id. */
  itemId: string
  description: string
  action: string
  enabled: boolean
  quick: boolean
  interface: string[]
  interfacenot: boolean
  direction: string
  ipprotocol: string
  protocol: string
  sourceNet: string[]
  sourceNot: boolean
  sourcePort: string
  destinationNet: string[]
  destinationNot: boolean
  destinationPort: string
  log: boolean
  categories: string[]
  statetype: string
  sequence: number
}

export function extractFilterRuleSpecs(canvas: CanvasSnapshot): FilterRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id ?? item.name,
      description: asString(f.description),
      action: asString(f.action) || 'pass',
      enabled: asBool(f.enabled, true),
      quick: asBool(f.quick, true),
      interface: strList(f.interface),
      interfacenot: asBool(f.interfacenot, false),
      direction: asString(f.direction) || 'in',
      ipprotocol: asString(f.ipprotocol) || 'inet',
      protocol: asString(f.protocol) || 'any',
      sourceNet: strList(f.source_net).length > 0 ? strList(f.source_net) : ['any'],
      sourceNot: asBool(f.source_not, false),
      sourcePort: asString(f.source_port),
      destinationNet: strList(f.destination_net).length > 0 ? strList(f.destination_net) : ['any'],
      destinationNot: asBool(f.destination_not, false),
      destinationPort: asString(f.destination_port),
      log: asBool(f.log, false),
      categories: strList(f.categories),
      statetype: asString(f.statetype) || 'keep',
      sequence: typeof f.sequence === 'number' && Number.isFinite(f.sequence) ? f.sequence : 1,
    }
  })
}

/**
 * Build the addRule/setRule body for a declared spec. `categoryUuids` is the
 * already-resolved (name -> uuid) list — resolution happens in deploy.ts,
 * which has live access to the category resource; this function stays pure.
 */
export function buildFilterRuleBody(spec: FilterRuleSpec, categoryUuids: string[]): FilterRuleBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    statetype: spec.statetype,
    sequence: String(spec.sequence),
    action: spec.action,
    quick: spec.quick ? '1' : '0',
    interfacenot: spec.interfacenot ? '1' : '0',
    interface: spec.interface.join(','),
    direction: spec.direction,
    ipprotocol: spec.ipprotocol,
    protocol: spec.protocol,
    source_net: spec.sourceNet.join(','),
    source_not: spec.sourceNot ? '1' : '0',
    source_port: spec.sourcePort,
    destination_net: spec.destinationNet.join(','),
    destination_not: spec.destinationNot ? '1' : '0',
    destination_port: spec.destinationPort,
    log: spec.log ? '1' : '0',
    categories: categoryUuids.join(','),
    description: spec.description,
  }
}

/** Snapshot a live rule (as returned by searchRule) into a setRule-ready body, for rollback restoration. */
export function snapshotLive(live: LiveFilterRule): FilterRuleBody {
  return {
    enabled: String(live.enabled ?? '1'),
    statetype: String(live.statetype ?? 'keep'),
    sequence: String(live.sequence ?? '1'),
    action: String(live.action ?? 'pass'),
    quick: String(live.quick ?? '1'),
    interfacenot: String(live.interfacenot ?? '0'),
    interface: String(live.interface ?? ''),
    direction: String(live.direction ?? 'in'),
    ipprotocol: String(live.ipprotocol ?? 'inet'),
    protocol: String(live.protocol ?? 'any'),
    source_net: String(live.source_net ?? 'any'),
    source_not: String(live.source_not ?? '0'),
    source_port: String(live.source_port ?? ''),
    destination_net: String(live.destination_net ?? 'any'),
    destination_not: String(live.destination_not ?? '0'),
    destination_port: String(live.destination_port ?? ''),
    log: String(live.log ?? '0'),
    categories: String(live.categories ?? ''),
    description: String(live.description ?? ''),
  }
}

export function isValidAction(value: string): boolean {
  return (ACTIONS as readonly string[]).includes(value)
}
export function isValidDirection(value: string): boolean {
  return (DIRECTIONS as readonly string[]).includes(value)
}
export function isValidIpProtocol(value: string): boolean {
  return (IP_PROTOCOLS as readonly string[]).includes(value)
}
export function isValidStateType(value: string): boolean {
  return (STATE_TYPES as readonly string[]).includes(value)
}
