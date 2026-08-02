// Shared helpers for the Imperva Cloud WAF ACL Rules config type (deploy +
// rollback + drift). Shapes follow the legacy Cloud WAF (Incapsula) management
// API v1 IncapRules endpoints (POST /sites/incapRules/{add,edit,delete,list}).
//
// Rule field names + the security action set are taken from Imperva's official
// Terraform provider (incapsula/client_incap_rule.go, incap_rule docs). The exact
// list-response envelope is tolerated defensively — verify against a live Imperva.

import { type ImpervaEnvelope } from '../../lib/impervaApi'

/**
 * The SECURITY (ACL) rule actions — block, alert or challenge traffic. These are
 * the subset of IncapRule actions that gate access (as opposed to the delivery /
 * rewrite actions), and the only ones this config type authors. Values are the
 * verbatim Imperva `RULE_ACTION_*` constants.
 */
export const SECURITY_ACTIONS = new Set([
  'RULE_ACTION_BLOCK', // block the request
  'RULE_ACTION_ALERT', // log/alert only, do not block
  'RULE_ACTION_BLOCK_USER', // block the session
  'RULE_ACTION_BLOCK_IP', // block the client IP
  'RULE_ACTION_RETRY', // require cookie support
  'RULE_ACTION_INTRUSIVE_HTML', // require JavaScript support
  'RULE_ACTION_CAPTCHA', // present a CAPTCHA challenge
])

/** One IncapRule as returned by the v1 API (the fields this config relies on). */
export interface IncapRule {
  /** Rule identifier — `rule_id` in v1; some responses echo it as `id`. */
  rule_id?: number | string
  id?: number | string
  name?: string
  action?: string
  filter?: string
  enabled?: boolean | number | string
  [key: string]: unknown
}

/**
 * Extract the rules array from a v1 `incapRules/list` response. The exact shape is
 * tolerated defensively across the forms Imperva has used:
 *   { incap_rules: [...] } | { rules: [...] } | { incap_rules: { All: [...] } } |
 *   { rules: { All: [...] } } | [...]
 */
export function rulesFromResponse(payload: ImpervaEnvelope | unknown[] | null): IncapRule[] {
  if (Array.isArray(payload)) return payload as IncapRule[]
  if (!payload || typeof payload !== 'object') return []
  const obj = payload as Record<string, unknown>
  const container = obj.incap_rules ?? obj.rules
  if (Array.isArray(container)) return container as IncapRule[]
  if (container && typeof container === 'object') {
    const all = (container as Record<string, unknown>).All
    if (Array.isArray(all)) return all as IncapRule[]
    // Fall back to concatenating any array-valued buckets (e.g. { All, Alert, ... }).
    return Object.values(container as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? (v as IncapRule[]) : []))
  }
  return []
}

/**
 * `enabled` may arrive from the canvas as an 'enabled'/'disabled' string, or from
 * Imperva as a boolean / 'true'|'false' / 1|0 — normalize to a boolean. Empty /
 * unknown defaults to enabled (true), matching Imperva's default.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0' || s === 'no') return false
  return true
}

/** The rule id from a rule (v1 `rule_id`, falling back to `id`), or null. */
export function ruleIdOf(rule: IncapRule): number | string | null {
  return rule.rule_id ?? rule.id ?? null
}

/** Find a live rule by (case-insensitive) name — the stable identity within a site. */
export function findRule(rules: IncapRule[], name: string): IncapRule | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return rules.find((r) => String(r.name ?? '').trim().toLowerCase() === n) ?? null
}

export interface RuleFields {
  siteId: string
  name: string
  action: string
  filter: string
  enabled: boolean
}

/** Read + normalize the canvas fields for one ACL rule item. */
export function readRuleFields(fields: Record<string, unknown>): RuleFields {
  return {
    siteId: String(fields.siteId ?? '').trim(),
    name: String(fields.name ?? '').trim(),
    action: String(fields.action ?? '').trim(),
    filter: String(fields.filter ?? '').trim(),
    enabled: normalizeEnabled(fields.enabled),
  }
}

/**
 * The parameter set common to add + edit. `enabled` is sent as the string
 * 'true'/'false' (the v1 form-param convention). `filter` is omitted when empty —
 * an empty filter means the rule always runs.
 */
export function ruleParams(fields: RuleFields): Record<string, string> {
  const params: Record<string, string> = {
    name: fields.name,
    action: fields.action,
    enabled: String(fields.enabled),
  }
  if (fields.filter) params.filter = fields.filter
  return params
}
