// =============================================================================
// Shared spec/validation/wire-format helpers for the Aqua Security
// firewall-policies config type (validate + deploy + rollback + drift).
// Mirrors client.FirewallPolicy / client.Networks (client/firewall_policy.go)
// — see lib/aquasec.ts's module doc for the endpoint citation.
// =============================================================================

import type { CanvasSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import type { AquaFirewallPolicy, AquaNetworkRule } from '../../lib/aquasec'
import { normalizeBoolean } from '../lib/common'

export const RESOURCE_TYPES = new Set(['anywhere', 'custom', 'vpc'])

export interface FirewallPolicySpec {
  itemId?: string
  name: string
  description: string
  blockIcmpPing: boolean
  blockMetadataService: boolean
  inboundNetworksJson: string
  outboundNetworksJson: string
}

export function extractFirewallPolicySpecs(canvas: CanvasSnapshot): FirewallPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(f.name ?? '').trim(),
      description: String(f.description ?? '').trim(),
      blockIcmpPing: normalizeBoolean(f.blockIcmpPing, false),
      blockMetadataService: normalizeBoolean(f.blockMetadataService, false),
      inboundNetworksJson: typeof f.inboundNetworksJson === 'string' ? f.inboundNetworksJson : '',
      outboundNetworksJson: typeof f.outboundNetworksJson === 'string' ? f.outboundNetworksJson : '',
    }
  })
}

/** Parse a network-rules JSON textarea. Returns the parsed rules, or an error message. */
export function parseNetworkRules(json: string): { rules: AquaNetworkRule[]; error?: string } {
  const trimmed = json.trim()
  if (!trimmed) return { rules: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { rules: [], error: `is not valid JSON (${e instanceof Error ? e.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { rules: [], error: 'must be a JSON array' }

  const rules: AquaNetworkRule[] = []
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (!entry || typeof entry !== 'object') return { rules: [], error: `entry [${i}] must be an object` }
    const e = entry as Record<string, unknown>
    if (typeof e.allow !== 'boolean') return { rules: [], error: `entry [${i}].allow must be a boolean` }
    if (typeof e.resourceType !== 'string' || !RESOURCE_TYPES.has(e.resourceType)) {
      return { rules: [], error: `entry [${i}].resourceType must be one of ${[...RESOURCE_TYPES].join(', ')}` }
    }
    if (typeof e.portRange !== 'string' || !e.portRange.trim()) {
      return { rules: [], error: `entry [${i}].portRange is required, e.g. "0-1000"` }
    }
    if (e.resourceType === 'custom' && (typeof e.resource !== 'string' || !e.resource.trim())) {
      return { rules: [], error: `entry [${i}].resource is required when resourceType is "custom"` }
    }
    rules.push({
      allow: e.allow,
      resource_type: e.resourceType,
      port_range: e.portRange,
      resource: typeof e.resource === 'string' ? e.resource : undefined,
    })
  }
  return { rules }
}

export function buildFirewallPolicyBody(spec: FirewallPolicySpec): AquaFirewallPolicy {
  return {
    name: spec.name,
    description: spec.description,
    block_icmp_ping: spec.blockIcmpPing,
    block_metadata_service: spec.blockMetadataService,
    inbound_networks: parseNetworkRules(spec.inboundNetworksJson).rules,
    outbound_networks: parseNetworkRules(spec.outboundNetworksJson).rules,
  }
}

function displayRules(rules: AquaNetworkRule[] | undefined): string {
  return [...(rules ?? [])]
    .map((r) => `${r.allow ? 'allow' : 'deny'}:${r.resource_type}:${r.port_range}:${r.resource ?? ''}`)
    .sort()
    .join(', ')
}

export function diffFirewallPolicy(spec: FirewallPolicySpec, live: AquaFirewallPolicy): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const push = (field: string, expected: unknown, actual: unknown, severity: DriftDiff['severity'] = 'warning') => {
    diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity })
  }

  if (spec.blockIcmpPing !== Boolean(live.block_icmp_ping)) push('blockIcmpPing', spec.blockIcmpPing, Boolean(live.block_icmp_ping))
  if (spec.blockMetadataService !== Boolean(live.block_metadata_service)) {
    push('blockMetadataService', spec.blockMetadataService, Boolean(live.block_metadata_service), 'critical')
  }

  const declaredInbound = displayRules(parseNetworkRules(spec.inboundNetworksJson).rules)
  const actualInbound = displayRules(live.inbound_networks)
  if (declaredInbound !== actualInbound) push('inboundNetworks', declaredInbound, actualInbound, 'critical')

  const declaredOutbound = displayRules(parseNetworkRules(spec.outboundNetworksJson).rules)
  const actualOutbound = displayRules(live.outbound_networks)
  if (declaredOutbound !== actualOutbound) push('outboundNetworks', declaredOutbound, actualOutbound, 'critical')

  return diffs
}
