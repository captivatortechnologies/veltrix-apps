// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense one-to-one-nat
// config type (`/api/firewall/one_to_one/*`, REQUIRES OPNsense 24.1.9+ — see
// lib/oneToOneNatApi.ts's module doc for the full citation trail).
//
// IDENTITY: like firewall-rules/source-nat, `onetoone.rule` has NO name field
// at all (verified: Filter.xml — see lib/oneToOneNatApi.ts's LiveOneToOneRule).
// This app reconciles by the CANVAS ITEM's own stable `itemId`, mapped to the
// OPNsense-assigned `uuid`, carried across deploys in rollbackData — the same
// approach used for firewall-rules/source-nat. `description` is REQUIRED by
// this app's OWN canvas purely for a human label; it plays no role in matching.
//
// Dropped for v0.3.0, flagged rather than faked: `categories` IS supported
// (resolved by name like every other rule type), but NPTv6 (`npt.rule` — the
// fourth resource sharing this same Filter.xml model) is NOT built this wave;
// see README's Coverage section.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { LiveOneToOneRule, OneToOneRuleBody } from '../../lib/oneToOneNatApi'

export const TYPES = ['binat', 'nat'] as const
export const NAT_REFLECTION = ['', 'enable', 'disable'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list — used only for `categories`. */
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

export interface OneToOneRuleSpec {
  /** The canvas item's own stable id — the TRUE identity for reconcile (see module doc). Falls back to item.name for test fixtures that omit id. */
  itemId: string
  description: string
  enabled: boolean
  log: boolean
  sequence: number
  interfaceName: string
  type: string // "binat" | "nat"
  sourceNet: string
  sourceNot: boolean
  destinationNet: string
  destinationNot: boolean
  external: string
  natReflection: string
  categories: string[]
}

export function extractOneToOneRuleSpecs(canvas: CanvasSnapshot): OneToOneRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id ?? item.name,
      description: asString(f.description),
      enabled: asBool(f.enabled, true),
      log: asBool(f.log, false),
      sequence: typeof f.sequence === 'number' && Number.isFinite(f.sequence) ? f.sequence : 1,
      interfaceName: asString(f.interface) || 'wan',
      type: asString(f.type) || 'binat',
      sourceNet: asString(f.source_net),
      sourceNot: asBool(f.source_not, false),
      destinationNet: asString(f.destination_net) || 'any',
      destinationNot: asBool(f.destination_not, false),
      external: asString(f.external),
      natReflection: asString(f.natreflection),
      categories: strList(f.categories),
    }
  })
}

/** Build the addRule/setRule body for a declared spec. `categoryUuids` is the already-resolved (name -> uuid) list. */
export function buildOneToOneRuleBody(spec: OneToOneRuleSpec, categoryUuids: string[]): OneToOneRuleBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    log: spec.log ? '1' : '0',
    sequence: String(spec.sequence),
    interface: spec.interfaceName,
    type: spec.type,
    source_net: spec.sourceNet,
    source_not: spec.sourceNot ? '1' : '0',
    destination_net: spec.destinationNet,
    destination_not: spec.destinationNot ? '1' : '0',
    external: spec.external,
    natreflection: spec.natReflection,
    categories: categoryUuids.join(','),
    description: spec.description,
  }
}

/** Snapshot a live rule (as returned by searchRule) into a setRule-ready body, for rollback restoration. */
export function snapshotLive(live: LiveOneToOneRule): OneToOneRuleBody {
  return {
    enabled: String(live.enabled ?? '1'),
    log: String(live.log ?? '0'),
    sequence: String(live.sequence ?? '1'),
    interface: String(live.interface ?? 'wan'),
    type: String(live.type ?? 'binat'),
    source_net: String(live.source_net ?? ''),
    source_not: String(live.source_not ?? '0'),
    destination_net: String(live.destination_net ?? 'any'),
    destination_not: String(live.destination_not ?? '0'),
    external: String(live.external ?? ''),
    natreflection: String(live.natreflection ?? ''),
    categories: String(live.categories ?? ''),
    description: String(live.description ?? ''),
  }
}

export function isValidType(value: string): boolean {
  return (TYPES as readonly string[]).includes(value)
}
export function isValidNatReflection(value: string): boolean {
  return (NAT_REFLECTION as readonly string[]).includes(value)
}
