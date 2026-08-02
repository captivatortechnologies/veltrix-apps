// Shared helpers for the Imperva Cloud WAF Security Rules config type
// (deploy + rollback + drift). Each item is one WAF threat-protection setting on
// a site, SET declaratively over the legacy Cloud WAF (Incapsula) v1 API
// (POST /sites/configure/security) and read back from POST /sites/status
// (security.waf.rules[]).
//
// Rule ids, per-rule parameters, the security-action enum and the DDoS parameter
// value sets are taken from Imperva's official open-source Terraform provider
// (incapsula/client_waf_security_rule.go, incapsula/resource_waf_security_rule.go,
// incapsula/client_site.go) and the waf_security_rule docs. FLAG: the exact
// /sites/status security.waf.rules shape is tolerated defensively and should be
// confirmed against a live Imperva account.

import { type ImpervaEnvelope } from '../../lib/impervaApi'

/** Threat rules configured by a `security_rule_action` (block/alert/…). */
export const ACTION_RULE_IDS = new Set([
  'api.threats.backdoor',
  'api.threats.cross_site_scripting',
  'api.threats.illegal_resource_access',
  'api.threats.remote_file_inclusion',
  'api.threats.sql_injection',
])

/** DDoS protection rule — configured by activation mode + threshold. */
export const DDOS_RULE_ID = 'api.threats.ddos'

/** Bot access-control rule — configured by the two bot toggles. */
export const BOT_RULE_ID = 'api.threats.bot_access_control'

/** Every rule id this config type can author. */
export const SECURITY_RULE_IDS = new Set<string>([...ACTION_RULE_IDS, DDOS_RULE_ID, BOT_RULE_ID])

/** The security actions a threat rule may take. */
export const SECURITY_ACTIONS = new Set([
  'api.threats.action.block_request',
  'api.threats.action.block_ip',
  'api.threats.action.block_user',
  'api.threats.action.alert',
  'api.threats.action.disabled',
  'api.threats.action.quarantine_url', // backdoor only
])

export const DDOS_ACTIVATION_MODES = new Set([
  'api.threats.ddos.activation_mode.off',
  'api.threats.ddos.activation_mode.auto',
  'api.threats.ddos.activation_mode.on',
  'api.threats.ddos.activation_mode.adaptive',
])

/** Valid DDoS request-rate thresholds (form-param strings). */
export const DDOS_THRESHOLDS = new Set(['10', '20', '50', '100', '200', '500', '750', '1000', '2000', '3000', '4000', '5000'])

export const UNKNOWN_CLIENTS_CHALLENGES = new Set(['none', 'cookies', 'javascript', 'captcha'])

export const BOOL_STRINGS = new Set(['true', 'false'])

export type SecurityKind = 'action' | 'ddos' | 'bot'

/** Which parameter family a rule id belongs to, or null when unknown. */
export function classifyRule(ruleId: string): SecurityKind | null {
  if (ACTION_RULE_IDS.has(ruleId)) return 'action'
  if (ruleId === DDOS_RULE_ID) return 'ddos'
  if (ruleId === BOT_RULE_ID) return 'bot'
  return null
}

export interface SecurityRuleFields {
  siteId: string
  ruleId: string
  securityRuleAction: string
  activationMode: string
  ddosTrafficThreshold: string
  unknownClientsChallenge: string
  blockNonEssentialBots: string
  blockBadBots: string
  challengeSuspectedBots: string
}

/** Read + trim the canvas fields for one security-rule item. */
export function readSecurityFields(fields: Record<string, unknown>): SecurityRuleFields {
  const s = (k: string) => String(fields[k] ?? '').trim()
  return {
    siteId: s('siteId'),
    ruleId: s('ruleId'),
    securityRuleAction: s('securityRuleAction'),
    activationMode: s('activationMode'),
    ddosTrafficThreshold: s('ddosTrafficThreshold'),
    unknownClientsChallenge: s('unknownClientsChallenge'),
    blockNonEssentialBots: s('blockNonEssentialBots'),
    blockBadBots: s('blockBadBots'),
    challengeSuspectedBots: s('challengeSuspectedBots'),
  }
}

/**
 * The desired parameter set for a rule (API param names → values), derived from
 * the declared fields. Only the parameters that apply to the rule's kind are
 * included; empty optionals are omitted (the API keeps the existing value). These
 * keys double as the /sites/configure/security form parameters.
 */
export function declaredSecurityValues(fields: SecurityRuleFields): Record<string, string> {
  const kind = classifyRule(fields.ruleId)
  if (kind === 'action') {
    return { security_rule_action: fields.securityRuleAction }
  }
  if (kind === 'ddos') {
    const v: Record<string, string> = {
      activation_mode: fields.activationMode,
      ddos_traffic_threshold: fields.ddosTrafficThreshold,
    }
    if (fields.unknownClientsChallenge) v.unknown_clients_challenge = fields.unknownClientsChallenge
    if (fields.blockNonEssentialBots) v.block_non_essential_bots = fields.blockNonEssentialBots
    return v
  }
  if (kind === 'bot') {
    const v: Record<string, string> = {}
    if (fields.blockBadBots) v.block_bad_bots = fields.blockBadBots
    if (fields.challengeSuspectedBots) v.challenge_suspected_bots = fields.challengeSuspectedBots
    return v
  }
  return {}
}

/** One WAF rule as returned inside /sites/status → security.waf.rules[]. */
export interface WafRuleStatus {
  id?: string
  action?: string
  activation_mode?: string
  ddos_traffic_threshold?: number | string
  unknown_clients_challenge?: string
  block_non_essential_bots?: boolean | string
  block_bad_bots?: boolean | string
  challenge_suspected_bots?: boolean | string
  [key: string]: unknown
}

/** Extract the WAF rules array from a /sites/status envelope, defensively. */
export function wafRulesFromStatus(status: ImpervaEnvelope | null): WafRuleStatus[] {
  const security = status && typeof status === 'object' ? (status as Record<string, unknown>).security : undefined
  const waf = security && typeof security === 'object' ? (security as Record<string, unknown>).waf : undefined
  const rules = waf && typeof waf === 'object' ? (waf as Record<string, unknown>).rules : undefined
  return Array.isArray(rules) ? (rules as WafRuleStatus[]) : []
}

/** Find the live rule for a rule id (the singleton per site), or null. */
export function findWafRule(rules: WafRuleStatus[], ruleId: string): WafRuleStatus | null {
  return rules.find((r) => String(r.id ?? '') === ruleId) ?? null
}

/** Normalize a boolean-ish status value to 'true' / 'false' / '' (unknown). */
export function boolToStr(value: unknown): string {
  if (typeof value === 'boolean') return String(value)
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1') return 'true'
  if (s === 'false' || s === '0') return 'false'
  return ''
}

/**
 * The live parameter values for a rule (same API param-name keys as
 * declaredSecurityValues), read from its /sites/status entry. Used to record the
 * prior value for rollback and to compare for drift. Empty values mean the status
 * did not carry that field.
 */
export function liveSecurityValues(rule: WafRuleStatus, kind: SecurityKind): Record<string, string> {
  if (kind === 'action') {
    return { security_rule_action: String(rule.action ?? '') }
  }
  if (kind === 'ddos') {
    return {
      activation_mode: String(rule.activation_mode ?? ''),
      ddos_traffic_threshold: rule.ddos_traffic_threshold != null ? String(rule.ddos_traffic_threshold) : '',
      unknown_clients_challenge: String(rule.unknown_clients_challenge ?? ''),
      block_non_essential_bots: boolToStr(rule.block_non_essential_bots),
    }
  }
  if (kind === 'bot') {
    return {
      block_bad_bots: boolToStr(rule.block_bad_bots),
      challenge_suspected_bots: boolToStr(rule.challenge_suspected_bots),
    }
  }
  return {}
}
