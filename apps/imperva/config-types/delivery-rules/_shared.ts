// Shared helpers for the Imperva Cloud WAF Delivery Rules config type (deploy +
// rollback + drift). Delivery Rules is the SAME underlying resource as ACL Rules
// (IncapRules, POST /sites/incapRules/{add,edit,delete,list}) — the legacy Cloud
// WAF (Incapsula) management API v1 — but authors the DELIVERY / rewrite / rate /
// custom-error subset of `action` values instead of the security (block/alert)
// subset. Rules are upserted by NAME within a site, exactly like ACL Rules.
//
// NOT to be confused with Imperva's NEWER `incapsula_delivery_rules_configuration`
// resource (a v3, category-ordered replacement) — that is a distinct, newer API
// surface and stays out of scope for this app (legacy v1 only). This config type
// reuses the SAME v1 IncapRules endpoint ACL Rules already targets.
//
// Action set, per-action parameters and example bodies are taken from Imperva's
// official open-source Terraform provider (incapsula/client_incap_rule.go,
// resource_incap_rule.go, website/docs/r/incap_rule.html.markdown) and confirmed
// against Imperva's own legacy v1 API blog post (POST .../sites/incapRules/add
// with action=RULE_ACTION_REDIRECT). FLAG: the exact list-response envelope is
// tolerated defensively (see rulesFromResponse in lib/impervaApi.ts) and the
// full parameter set per action was not independently confirmed end-to-end
// against a live tenant — verify against a live Imperva account.

import { rulesFromResponse, ruleIdOf, findRule, normalizeEnabled, type IncapRule } from '../../lib/impervaApi'

export { rulesFromResponse, ruleIdOf, findRule, normalizeEnabled, type IncapRule }

/**
 * The DELIVERY rule actions — redirect, rewrite, delete, rate-limit and
 * custom-error-response. Deliberately excludes `RULE_ACTION_WAF_OVERRIDE`
 * (a hybrid action that overrides a built-in WAF rule's action for a specific
 * filter — closer in spirit to Security Rules than to delivery/rewrite — and
 * the SECURITY actions ACL Rules already owns).
 */
export const DELIVERY_ACTIONS = new Set([
  'RULE_ACTION_REDIRECT',
  'RULE_ACTION_SIMPLIFIED_REDIRECT',
  'RULE_ACTION_REWRITE_URL',
  'RULE_ACTION_REWRITE_HEADER',
  'RULE_ACTION_REWRITE_COOKIE',
  'RULE_ACTION_DELETE_HEADER',
  'RULE_ACTION_DELETE_COOKIE',
  'RULE_ACTION_RESPONSE_REWRITE_HEADER',
  'RULE_ACTION_RESPONSE_DELETE_HEADER',
  'RULE_ACTION_RESPONSE_REWRITE_RESPONSE_CODE',
  'RULE_ACTION_FORWARD_TO_DC',
  'RULE_ACTION_FORWARD_TO_PORT',
  'RULE_ACTION_RATE',
  'RULE_ACTION_CUSTOM_ERROR_RESPONSE',
])

export const REDIRECT_RESPONSE_CODES = new Set(['301', '302', '303', '307', '308'])
export const CUSTOM_ERROR_RESPONSE_CODES = new Set([
  '400', '401', '402', '403', '404', '405', '406', '407', '408', '409', '410',
  '411', '412', '413', '414', '415', '416', '417', '419', '420', '422', '423',
  '424', '500', '501', '502', '503', '504', '505', '507',
])
export const ERROR_TYPES = new Set([
  'error.type.all',
  'error.type.connection_timeout',
  'error.type.access_denied',
  'error.type.parse_req_error',
  'error.type.parse_resp_error',
  'error.type.connection_failed',
  'error.type.deny_and_retry',
  'error.type.ssl_failed',
  'error.type.deny_and_captcha',
  'error.type.2fa_required',
  'error.type.no_ssl_config',
  'error.type.no_ipv6_config',
])
export const ERROR_RESPONSE_FORMATS = new Set(['json', 'xml'])
export const RATE_CONTEXTS = new Set(['IP', 'Session'])
export const PORT_FORWARDING_CONTEXTS = new Set(['Use Port Value', 'Use Header Name'])

/** Which parameter set an action needs, for canvas visibility + params building. */
export type DeliveryKind =
  | 'redirect'
  | 'rewrite_url'
  | 'rewrite_header_cookie'
  | 'delete_header_cookie'
  | 'response_rewrite_code'
  | 'forward_dc'
  | 'forward_port'
  | 'rate'
  | 'custom_error'

/** Classify an action into its parameter family, or null when unsupported. */
export function classifyDelivery(action: string): DeliveryKind | null {
  switch (action) {
    case 'RULE_ACTION_REDIRECT':
    case 'RULE_ACTION_SIMPLIFIED_REDIRECT':
      return 'redirect'
    case 'RULE_ACTION_REWRITE_URL':
      return 'rewrite_url'
    case 'RULE_ACTION_REWRITE_HEADER':
    case 'RULE_ACTION_REWRITE_COOKIE':
    case 'RULE_ACTION_RESPONSE_REWRITE_HEADER':
      return 'rewrite_header_cookie'
    case 'RULE_ACTION_DELETE_HEADER':
    case 'RULE_ACTION_DELETE_COOKIE':
    case 'RULE_ACTION_RESPONSE_DELETE_HEADER':
      return 'delete_header_cookie'
    case 'RULE_ACTION_RESPONSE_REWRITE_RESPONSE_CODE':
      return 'response_rewrite_code'
    case 'RULE_ACTION_FORWARD_TO_DC':
      return 'forward_dc'
    case 'RULE_ACTION_FORWARD_TO_PORT':
      return 'forward_port'
    case 'RULE_ACTION_RATE':
      return 'rate'
    case 'RULE_ACTION_CUSTOM_ERROR_RESPONSE':
      return 'custom_error'
    default:
      return null
  }
}

/**
 * The v1 IncapRule parameter keys relevant to a delivery kind (beyond the
 * common name/action/filter/enabled). Used to build BOTH the params sent on
 * add/edit (declaredDeliveryValues) and the comparable live values read from
 * `incapRules/list` (liveDeliveryValues) — the list response echoes rules back
 * under the SAME key names, so one key list serves both directions.
 */
function paramKeysFor(kind: DeliveryKind): string[] {
  switch (kind) {
    case 'redirect':
      return ['response_code', 'from', 'to']
    case 'rewrite_url':
      return ['from', 'to']
    case 'rewrite_header_cookie':
      return ['from', 'to', 'rewrite_name', 'add_missing', 'rewrite_existing']
    case 'delete_header_cookie':
      return ['rewrite_name', 'multiple_deletions']
    case 'response_rewrite_code':
      return ['response_code']
    case 'forward_dc':
      return ['dc_id']
    case 'forward_port':
      return ['port_forwarding_context', 'port_forwarding_value']
    case 'rate':
      return ['rate_context', 'rate_interval']
    case 'custom_error':
      return ['response_code', 'error_type', 'error_response_format', 'error_response_data']
    default:
      return []
  }
}

export interface DeliveryFields {
  siteId: string
  name: string
  action: string
  filter: string
  enabled: boolean
  response_code: string
  from: string
  to: string
  rewrite_name: string
  add_missing: string
  rewrite_existing: string
  multiple_deletions: string
  dc_id: string
  port_forwarding_context: string
  port_forwarding_value: string
  rate_context: string
  rate_interval: string
  error_type: string
  error_response_format: string
  error_response_data: string
}

/** Read + normalize the canvas fields for one delivery rule item. */
export function readDeliveryFields(fields: Record<string, unknown>): DeliveryFields {
  const s = (k: string) => String(fields[k] ?? '').trim()
  return {
    siteId: s('siteId'),
    name: s('name'),
    action: s('action'),
    filter: s('filter'),
    enabled: normalizeEnabled(fields.enabled),
    response_code: s('response_code'),
    from: s('from'),
    to: s('to'),
    rewrite_name: s('rewrite_name'),
    add_missing: s('add_missing'),
    rewrite_existing: s('rewrite_existing'),
    multiple_deletions: s('multiple_deletions'),
    dc_id: s('dc_id'),
    port_forwarding_context: s('port_forwarding_context'),
    port_forwarding_value: s('port_forwarding_value'),
    rate_context: s('rate_context'),
    rate_interval: s('rate_interval'),
    error_type: s('error_type'),
    error_response_format: s('error_response_format'),
    error_response_data: s('error_response_data'),
  }
}

/**
 * The params to send on add/edit: `name`, `action`, `enabled` always; `filter`
 * only when set (empty means "always run" — irrelevant for
 * RULE_ACTION_SIMPLIFIED_REDIRECT, where Imperva ignores it); plus every
 * non-empty param the action's kind uses.
 */
export function declaredDeliveryValues(fields: DeliveryFields): Record<string, string> {
  const params: Record<string, string> = { name: fields.name, action: fields.action, enabled: String(fields.enabled) }
  if (fields.filter) params.filter = fields.filter
  const kind = classifyDelivery(fields.action)
  if (!kind) return params
  for (const key of paramKeysFor(kind)) {
    const value = (fields as unknown as Record<string, string>)[key]
    if (value !== '') params[key] = value
  }
  return params
}

/** The comparable live values for a rule's kind, read from an IncapRules list entry. */
export function liveDeliveryValues(rule: IncapRule, kind: DeliveryKind): Record<string, string> {
  const values: Record<string, string> = {}
  for (const key of paramKeysFor(kind)) {
    const raw = rule[key]
    if (raw === undefined || raw === null) continue
    values[key] = typeof raw === 'boolean' ? String(raw) : String(raw)
  }
  return values
}
