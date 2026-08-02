// =============================================================================
// Shared helpers for the Cisco Meraki L3 Firewall Rules config type.
//
// IMPORTANT — this is an ordered SINGLETON per network, not a collection.
// Meraki stores a network's whole MX L3 (outbound) firewall ruleset as ONE
// ordered list; the API has no create/delete of an individual rule, only a
// whole-list PUT. Rules are evaluated top-to-bottom, so ORDER is significant.
// This config type therefore models ONE item per Meraki network whose identity
// is the network's `network_id` and whose payload is the ordered `rules` array
// (the shared shape used by Cribl's Routes config type for the same reason).
//
// The API's list EXCLUDES the implicit final "Default rule" (allow any/any) —
// Meraki appends it automatically after every custom rule and it is never
// created, edited or deleted through this endpoint.
//
// NOTE: the rule shape (policy/protocol/srcPort/srcCidr/destPort/destCidr/
// syslogEnabled) and the whole-list PUT semantics follow the documented Meraki
// Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-l-3-firewall-rules/).
// Verify against a live Meraki organization.
//
// Network-id validation and order/key-sensitive JSON comparison are shared with
// every other Meraki config type (l7-firewall-rules, group-policies,
// appliance-vlans) — see lib/merakiCommon.ts. Re-exported here so every
// existing local import stays unchanged.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { NETWORK_ID_RE, canonicalJson, looksLikeKnownNetworkId, networkIdKey, readBool } from '../../lib/merakiCommon'

export { NETWORK_ID_RE, canonicalJson, looksLikeKnownNetworkId, networkIdKey, readBool }

/** Rule field values accepted by `l3FirewallRules.policy`. */
export const POLICIES = ['allow', 'deny'] as const
/** Rule field values accepted by `l3FirewallRules.protocol`. */
export const PROTOCOLS = ['any', 'icmp', 'icmp6', 'tcp', 'udp'] as const

/** One rule in the ordered ruleset (the shape `l3FirewallRules.rules[]` uses both ways). */
export interface MerakiL3FirewallRule {
  comment?: string
  policy: string
  protocol: string
  srcPort: string
  srcCidr: string
  destPort: string
  destCidr: string
  syslogEnabled?: boolean
}

export interface ParsedRules {
  rules: MerakiL3FirewallRule[] | null
  error: string | null
}

/**
 * Parse the `rules` textarea (JSON) into the ordered rule list. Accepts either
 * a bare `[ ... ]` array of rules or a `{ "rules": [...] }` object (any other
 * top-level key in the object form is ignored — `syslog_default_rule` is its
 * own canvas field).
 */
export function parseRules(raw: unknown): ParsedRules {
  const text = String(raw ?? '').trim()
  if (!text) return { rules: null, error: 'rules is empty — provide the ordered ruleset as JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { rules: null, error: `rules is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }

  if (Array.isArray(parsed)) return { rules: parsed as MerakiL3FirewallRule[], error: null }
  if (!parsed || typeof parsed !== 'object') {
    return { rules: null, error: 'rules must be a JSON array of rules, or an object with a "rules" array.' }
  }
  const rules = (parsed as Record<string, unknown>).rules
  if (!Array.isArray(rules)) return { rules: null, error: 'rules object must contain a "rules" array.' }
  return { rules: rules as MerakiL3FirewallRule[], error: null }
}

/** Trim a string field, defaulting to "any" when blank (Meraki's own wildcard value). */
function portOrCidr(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : 'any'
}

/**
 * Normalize one parsed rule to the exact shape the API expects: lower-cased
 * enums, "any" defaults for the four match fields, and syslogEnabled coerced
 * to a real boolean. Does not validate — see validate.ts for that.
 */
export function normalizeRule(rule: Partial<MerakiL3FirewallRule> | null | undefined): MerakiL3FirewallRule {
  const r = rule ?? {}
  return {
    comment: typeof r.comment === 'string' ? r.comment.trim() : '',
    policy: typeof r.policy === 'string' ? r.policy.trim().toLowerCase() : '',
    protocol: typeof r.protocol === 'string' ? r.protocol.trim().toLowerCase() : '',
    srcPort: portOrCidr(r.srcPort),
    srcCidr: portOrCidr(r.srcCidr),
    destPort: portOrCidr(r.destPort),
    destCidr: portOrCidr(r.destCidr),
    syslogEnabled: r.syslogEnabled === true,
  }
}

/**
 * Build the PUT request body. `syslogDefaultRule` is included whenever the
 * caller passes one (deploy always declares it); rollback omits it entirely —
 * see rollback.ts for why it can never be restored to a prior value.
 */
export function buildRulesBody(
  rules: MerakiL3FirewallRule[],
  syslogDefaultRule?: boolean,
): { rules: MerakiL3FirewallRule[]; syslogDefaultRule?: boolean } {
  return syslogDefaultRule === undefined ? { rules } : { rules, syslogDefaultRule }
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface L3FirewallRuleSpec {
  itemName: string
  networkId: string
  comment: string
  rulesRaw: unknown
  syslogDefaultRule: boolean
}

/** Each canvas item describes one Meraki network's L3 firewall ruleset. */
export function extractL3FirewallRuleSpecs(canvas: CanvasSnapshot): L3FirewallRuleSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      networkId: str(fields.network_id),
      comment: str(fields.comment),
      rulesRaw: fields.rules,
      syslogDefaultRule: readBool(fields.syslog_default_rule, false),
    }
  })
}
