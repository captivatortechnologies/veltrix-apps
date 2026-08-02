// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense source-nat
// (outbound NAT) config type (`/api/firewall/source_nat/*`, REQUIRES OPNsense
// 24.1+ — see lib/opnsenseApi.ts's SOURCE_NAT_MODULE doc for the full
// citation trail — the SAME release/commit that added firewall-rules).
//
// IDENTITY: exactly like firewall-rules, `snatrules.rule` has NO name field
// (verified: Filter.xml — see lib/opnsenseApi.ts's LiveSourceNatRule). This
// app reconciles by the CANVAS ITEM's own stable `itemId`, mapped to the
// OPNsense-assigned `uuid`, carried across deploys in rollbackData.
// `description` is REQUIRED by this app's OWN canvas for the same reason as
// firewall-rules — a human label, not a matching key.
//
// UNLIKE firewall-rules, `source_net`/`destination_net`/`target` on this
// model have NO `Multiple` flag — each is a SINGLE value, not a comma-joined
// list — so this config type's canvas fields for them are plain text, not tags.
//
// Dropped for v0.2.0, flagged rather than faked: `nosync`, `tag`/`tagged`
// (advanced pf tagging, same reasoning as firewall-rules).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { LiveSourceNatRule, SourceNatRuleBody } from '../../lib/opnsenseApi'

export const IP_PROTOCOLS = ['inet', 'inet6'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Trim a string field, defaulting ONLY when the raw value was never provided
 * (undefined/null — e.g. an older canvas snapshot predating this field's
 * defaultValue). An EXPLICIT empty string is preserved as-is so a required
 * field left blank in the canvas is still caught by validate.ts, instead of
 * silently becoming "valid" via the same default a truly-absent value gets.
 */
function asStringWithDefault(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback
  return asString(value)
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

export interface SourceNatRuleSpec {
  /** The canvas item's own stable id — the TRUE identity for reconcile (see module doc). Falls back to item.name for test fixtures that omit id. */
  itemId: string
  description: string
  enabled: boolean
  nonat: boolean
  interfaceName: string
  ipprotocol: string
  protocol: string
  sourceNet: string
  sourceNot: boolean
  sourcePort: string
  destinationNet: string
  destinationNot: boolean
  destinationPort: string
  target: string
  targetPort: string
  staticNatPort: boolean
  log: boolean
  categories: string[]
  endpointIndependent: boolean
  sequence: number
}

export function extractSourceNatRuleSpecs(canvas: CanvasSnapshot): SourceNatRuleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id ?? item.name,
      description: asString(f.description),
      enabled: asBool(f.enabled, true),
      nonat: asBool(f.nonat, false),
      interfaceName: asStringWithDefault(f.interface, 'lan'),
      ipprotocol: asString(f.ipprotocol) || 'inet',
      protocol: asString(f.protocol) || 'any',
      sourceNet: asString(f.source_net) || 'any',
      sourceNot: asBool(f.source_not, false),
      sourcePort: asString(f.source_port),
      destinationNet: asString(f.destination_net) || 'any',
      destinationNot: asBool(f.destination_not, false),
      destinationPort: asString(f.destination_port),
      target: asString(f.target),
      targetPort: asString(f.target_port),
      staticNatPort: asBool(f.staticnatport, false),
      log: asBool(f.log, false),
      categories: strList(f.categories),
      endpointIndependent: asBool(f.endpoint_independent, false),
      sequence: typeof f.sequence === 'number' && Number.isFinite(f.sequence) ? f.sequence : 1,
    }
  })
}

/**
 * Build the addRule/setRule body for a declared spec. `categoryUuids` is the
 * already-resolved (name -> uuid) list — resolution happens in deploy.ts.
 */
export function buildSourceNatRuleBody(spec: SourceNatRuleSpec, categoryUuids: string[]): SourceNatRuleBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    nonat: spec.nonat ? '1' : '0',
    sequence: String(spec.sequence),
    interface: spec.interfaceName,
    ipprotocol: spec.ipprotocol,
    protocol: spec.protocol,
    source_net: spec.sourceNet,
    source_not: spec.sourceNot ? '1' : '0',
    source_port: spec.sourcePort,
    destination_net: spec.destinationNet,
    destination_not: spec.destinationNot ? '1' : '0',
    destination_port: spec.destinationPort,
    target: spec.target,
    target_port: spec.targetPort,
    staticnatport: spec.staticNatPort ? '1' : '0',
    log: spec.log ? '1' : '0',
    categories: categoryUuids.join(','),
    'endpoint-independent': spec.endpointIndependent ? '1' : '0',
    description: spec.description,
  }
}

/** Snapshot a live rule (as returned by searchRule) into a setRule-ready body, for rollback restoration. */
export function snapshotLive(live: LiveSourceNatRule): SourceNatRuleBody {
  return {
    enabled: String(live.enabled ?? '1'),
    nonat: String(live.nonat ?? '0'),
    sequence: String(live.sequence ?? '1'),
    interface: String(live.interface ?? 'lan'),
    ipprotocol: String(live.ipprotocol ?? 'inet'),
    protocol: String(live.protocol ?? 'any'),
    source_net: String(live.source_net ?? 'any'),
    source_not: String(live.source_not ?? '0'),
    source_port: String(live.source_port ?? ''),
    destination_net: String(live.destination_net ?? 'any'),
    destination_not: String(live.destination_not ?? '0'),
    destination_port: String(live.destination_port ?? ''),
    target: String(live.target ?? ''),
    target_port: String(live.target_port ?? ''),
    staticnatport: String(live.staticnatport ?? '0'),
    log: String(live.log ?? '0'),
    categories: String(live.categories ?? ''),
    'endpoint-independent': String(live['endpoint-independent'] ?? '0'),
    description: String(live.description ?? ''),
  }
}

export function isValidIpProtocol(value: string): boolean {
  return (IP_PROTOCOLS as readonly string[]).includes(value)
}

/** True when a fetched mode indicates manually-declared snatrules are actually evaluated by pf. */
export function modeHonorsManualRules(mode: string | null): boolean {
  return mode === 'hybrid' || mode === 'advanced'
}
