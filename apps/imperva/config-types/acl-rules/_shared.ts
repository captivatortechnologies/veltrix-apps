// Shared helpers for the Imperva Cloud WAF ACL Rules config type (deploy +
// rollback + drift). Shapes follow the legacy Cloud WAF (Incapsula) management
// API v1 IncapRules endpoints (POST /sites/incapRules/{add,edit,delete,list}).
//
// Rule field names + the security action set are taken from Imperva's official
// Terraform provider (incapsula/client_incap_rule.go, incap_rule docs). The exact
// list-response envelope is tolerated defensively — verify against a live Imperva.

// IncapRule / rulesFromResponse / ruleIdOf / findRule / normalizeEnabled are the
// generic parsing helpers for the shared IncapRules resource — moved to
// lib/impervaApi.ts so the delivery-rules config type (the same resource, the
// DELIVERY action subset) can reuse them instead of duplicating this parsing.
// Imported + re-exported here so existing imports from './_shared' keep working.
import { rulesFromResponse, ruleIdOf, findRule, normalizeEnabled, type IncapRule } from '../../lib/impervaApi'
export { type IncapRule, rulesFromResponse, ruleIdOf, findRule, normalizeEnabled }

/**
 * The SECURITY (ACL) rule actions — block, alert or challenge traffic. These are
 * the subset of IncapRule actions that gate access (as opposed to the delivery /
 * rewrite actions — see config-types/delivery-rules), and the only ones this
 * config type authors. Values are the verbatim Imperva `RULE_ACTION_*` constants.
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
