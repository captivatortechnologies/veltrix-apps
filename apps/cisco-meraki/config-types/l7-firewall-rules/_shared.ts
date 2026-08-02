// =============================================================================
// Shared helpers for the Cisco Meraki L7 Firewall Rules config type.
//
// Same ordered-SINGLETON-per-network shape as l3-firewall-rules (see that
// config type's _shared.ts for the rationale) — Meraki stores a network's
// whole L7 (application-layer) ruleset as ONE ordered list, only readable/
// writable as a whole via GET/PUT, never per-rule.
//
// L7 rules differ from L3 in three ways:
//   - `policy` only ever takes the value "deny" — L7 has no allow rule; it
//     layers additional blocks on top of the (default-allow) L3 posture.
//   - `value`'s shape depends on `type`: a plain string for host/port/ipRange,
//     an object for application/applicationCategory (an id looked up from the
//     MX L7 application-categories endpoint — NOT independently verified in
//     this app; see README), and an array of ISO 3166-1 alpha-2 country codes
//     for the country-based types.
//   - there is no "syslogDefaultRule"-style companion scalar — the PUT body is
//     always just `{ rules: [...] }`.
//
// NOTE: the rule shape and whole-list PUT semantics follow the documented
// Meraki Dashboard API v1
// (https://developer.cisco.com/meraki/api-v1/update-network-appliance-firewall-l-7-firewall-rules/).
// Verify against a live Meraki organization — in particular the exact `value`
// object shape for application/applicationCategory rules is FLAGGED as
// unverified (see README "Known limitations").
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, networkIdKey, looksLikeKnownNetworkId, readBool } from '../../lib/merakiCommon'

export { canonicalJson, networkIdKey, looksLikeKnownNetworkId, readBool }

/** L7 rule field values accepted by `l7FirewallRules.policy` — deny only. */
export const L7_POLICIES = ['deny'] as const

/**
 * L7 rule `type` values. Meraki's GET/PUT schemas list both the current names
 * (`allowedCountries` / `blockedCountries`) and legacy synonyms
 * (`whitelistedCountries` / `blacklistedCountries`) — both are accepted here
 * since the documented GET response schema shows all four.
 */
export const L7_TYPES = [
  'application',
  'applicationCategory',
  'host',
  'port',
  'ipRange',
  'allowedCountries',
  'blockedCountries',
  'whitelistedCountries',
  'blacklistedCountries',
] as const

/** `type` values whose `value` is an array of ISO 3166-1 alpha-2 country codes. */
export const L7_COUNTRY_TYPES = new Set<string>(['allowedCountries', 'blockedCountries', 'whitelistedCountries', 'blacklistedCountries'])
/** `type` values whose `value` is a plain non-empty string. */
export const L7_STRING_VALUE_TYPES = new Set<string>(['host', 'port', 'ipRange'])
/** `type` values whose `value` is an object referencing an application/category id — shape UNVERIFIED, see README. */
export const L7_OBJECT_VALUE_TYPES = new Set<string>(['application', 'applicationCategory'])

/** One rule in the ordered L7 ruleset. `value` intentionally stays `unknown` — its shape depends on `type`. */
export interface MerakiL7FirewallRule {
  policy: string
  type: string
  value: unknown
}

export interface ParsedL7Rules {
  rules: MerakiL7FirewallRule[] | null
  error: string | null
}

/**
 * Parse the `rules` textarea (JSON) into the ordered L7 rule list. Accepts
 * either a bare `[ ... ]` array or a `{ "rules": [...] }` object.
 */
export function parseL7Rules(raw: unknown): ParsedL7Rules {
  const text = String(raw ?? '').trim()
  if (!text) return { rules: null, error: 'rules is empty — provide the ordered L7 ruleset as JSON.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { rules: null, error: `rules is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }

  if (Array.isArray(parsed)) return { rules: parsed as MerakiL7FirewallRule[], error: null }
  if (!parsed || typeof parsed !== 'object') {
    return { rules: null, error: 'rules must be a JSON array of rules, or an object with a "rules" array.' }
  }
  const rules = (parsed as Record<string, unknown>).rules
  if (!Array.isArray(rules)) return { rules: null, error: 'rules object must contain a "rules" array.' }
  return { rules: rules as MerakiL7FirewallRule[], error: null }
}

/**
 * Normalize one parsed rule: lower-cased `policy`, `type` kept as declared
 * (case-sensitive — Meraki's type names are camelCase), `value` passed through
 * unchanged (its shape is type-dependent — see validate.ts for the checks).
 * Does not validate.
 */
export function normalizeL7Rule(rule: Partial<MerakiL7FirewallRule> | null | undefined): MerakiL7FirewallRule {
  const r = rule ?? {}
  return {
    policy: typeof r.policy === 'string' ? r.policy.trim().toLowerCase() : '',
    type: typeof r.type === 'string' ? r.type.trim() : '',
    value: r.value,
  }
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface L7FirewallRuleSpec {
  itemName: string
  networkId: string
  comment: string
  rulesRaw: unknown
}

/** Each canvas item describes one Meraki network's L7 firewall ruleset. */
export function extractL7FirewallRuleSpecs(canvas: CanvasSnapshot): L7FirewallRuleSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      itemName: item.name,
      networkId: str(fields.network_id),
      comment: str(fields.comment),
      rulesRaw: fields.rules,
    }
  })
}
