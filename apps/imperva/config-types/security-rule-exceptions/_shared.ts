// Shared helpers for the Imperva Cloud WAF Security Rule Exceptions config type
// (deploy + rollback + drift). An exception ("whitelist") lets a specific match
// condition (IPs, countries/continents, URLs, user agents, client apps/app
// types, request parameters) BYPASS one specific security or ACL rule on a
// site — distinct from ACL Configuration, which blacklists/whitelists
// SITE-WIDE rather than excepting a single rule. Managed over the legacy Cloud
// WAF (Incapsula) management API v1:
//   add/edit/delete: POST /sites/configure/whitelists
//   read:            POST /sites/status  → security.waf.rules[].exceptions[] /
//                                           security.acls.rules[].exceptions[]
//
// Unlike ACL Configuration / Security Rules (one singleton value per rule),
// MULTIPLE exceptions can exist per (site, rule) — and Imperva assigns each one
// a `whitelist_id` only once created, so there is no operator-declared name to
// upsert by. This config type instead reconciles by CONTENT: the match
// condition IS the exception's identity (declaring the same condition twice for
// the same rule is meaningless), so deploy diffs the declared exceptions
// against the live ones for (site, rule) by their normalized match values —
// adding declared-but-missing ones, deleting live-but-undeclared ones, and
// leaving an exact match alone (no API call, so untouched exceptions keep their
// live whitelist_id rather than being torn down and recreated every deploy).
//
// Rule ids, per-rule param mapping (which of client_apps/countries/continents/
// ips/urls/user_agents/parameters/client_app_types apply to which rule) and the
// /sites/status exceptions[] shape are taken from Imperva's official
// open-source Terraform provider (incapsula/client_security_rule_exception.go —
// securityRuleExceptionParamMapping — and resource_security_rule_exception.go's
// Read, which maps status value.id → exceptionType* constants). FLAG: not
// independently confirmed end-to-end against a live tenant — verify.

import { type ImpervaEnvelope } from '../../lib/impervaApi'

// ACL rule ids (site-wide blacklist rules an exception can except).
export const BLACKLISTED_COUNTRIES_RULE = 'api.acl.blacklisted_countries'
export const BLACKLISTED_IPS_RULE = 'api.acl.blacklisted_ips'
export const BLACKLISTED_URLS_RULE = 'api.acl.blacklisted_urls'
// WAF rule ids (threat rules an exception can except).
export const BACKDOOR_RULE = 'api.threats.backdoor'
export const BOT_ACCESS_CONTROL_RULE = 'api.threats.bot_access_control'
export const CROSS_SITE_SCRIPTING_RULE = 'api.threats.cross_site_scripting'
export const DDOS_RULE = 'api.threats.ddos'
export const ILLEGAL_RESOURCE_ACCESS_RULE = 'api.threats.illegal_resource_access'
export const REMOTE_FILE_INCLUSION_RULE = 'api.threats.remote_file_inclusion'
export const SQL_INJECTION_RULE = 'api.threats.sql_injection'

/** Which match-condition params each rule id's exceptions accept (per the provider's own mapping). */
export const EXCEPTION_PARAM_MAPPING: Record<string, string[]> = {
  [BLACKLISTED_COUNTRIES_RULE]: ['client_app_types', 'ips', 'urls'],
  [BLACKLISTED_IPS_RULE]: ['client_apps', 'countries', 'continents', 'ips', 'urls'],
  [BLACKLISTED_URLS_RULE]: ['client_apps', 'countries', 'continents', 'ips', 'urls'],
  [BACKDOOR_RULE]: ['client_apps', 'countries', 'continents', 'ips', 'urls', 'user_agents', 'parameters'],
  [BOT_ACCESS_CONTROL_RULE]: ['client_app_types', 'client_apps', 'countries', 'continents', 'ips', 'urls', 'user_agents'],
  [CROSS_SITE_SCRIPTING_RULE]: ['client_apps', 'countries', 'continents', 'urls', 'parameters'],
  [DDOS_RULE]: ['client_apps', 'countries', 'continents', 'ips', 'urls'],
  [ILLEGAL_RESOURCE_ACCESS_RULE]: ['client_apps', 'countries', 'continents', 'ips', 'urls', 'parameters'],
  [REMOTE_FILE_INCLUSION_RULE]: ['client_apps', 'countries', 'continents', 'ips', 'urls', 'user_agents', 'parameters'],
  [SQL_INJECTION_RULE]: ['client_apps', 'countries', 'continents', 'urls', 'parameters'],
}

export const EXCEPTION_RULE_IDS = new Set(Object.keys(EXCEPTION_PARAM_MAPPING))

/** ACL vs WAF — the two families /sites/status carries exceptions under. */
export function ruleFamily(ruleId: string): 'acl' | 'waf' | null {
  if (ruleId === BLACKLISTED_COUNTRIES_RULE || ruleId === BLACKLISTED_IPS_RULE || ruleId === BLACKLISTED_URLS_RULE) return 'acl'
  if (EXCEPTION_RULE_IDS.has(ruleId)) return 'waf'
  return null
}

export interface ExceptionFields {
  siteId: string
  ruleId: string
  clientAppTypes: string[]
  clientApps: string[]
  countries: string[]
  continents: string[]
  ips: string[]
  urls: string[]
  userAgents: string[]
  parameters: string[]
}

/** Coerce a canvas value (a tags array, or a comma/newline-separated string) to a trimmed string list. */
export function toList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(/[\n,]/)
  return raw.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Read + normalize the canvas fields for one exception item. */
export function readExceptionFields(fields: Record<string, unknown>): ExceptionFields {
  return {
    siteId: String(fields.siteId ?? '').trim(),
    ruleId: String(fields.ruleId ?? '').trim(),
    clientAppTypes: toList(fields.clientAppTypes),
    clientApps: toList(fields.clientApps),
    countries: toList(fields.countries),
    continents: toList(fields.continents),
    ips: toList(fields.ips),
    urls: toList(fields.urls),
    userAgents: toList(fields.userAgents),
    parameters: toList(fields.parameters),
  }
}

const FIELD_TO_PARAM: Record<string, keyof ExceptionFields> = {
  client_app_types: 'clientAppTypes',
  client_apps: 'clientApps',
  countries: 'countries',
  continents: 'continents',
  ips: 'ips',
  urls: 'urls',
  user_agents: 'userAgents',
  parameters: 'parameters',
}

/** The v1 `/sites/configure/whitelists` params for this exception's rule kind (comma-joined lists, empty ones omitted). */
export function exceptionParams(fields: ExceptionFields): Record<string, string> {
  const allowed = EXCEPTION_PARAM_MAPPING[fields.ruleId] ?? []
  const params: Record<string, string> = {}
  for (const param of allowed) {
    const values = fields[FIELD_TO_PARAM[param]] as string[]
    if (values.length > 0) params[param] = values.join(',')
  }
  return params
}

/**
 * A content signature for an exception — its rule id + every match value,
 * normalized (lowercased, sorted). Two exceptions with the same signature
 * declare the same condition and are treated as the SAME exception (this is
 * the identity this config type reconciles by, since Imperva assigns no
 * operator-facing name).
 */
export function exceptionSignature(fields: ExceptionFields): string {
  const parts = [
    fields.ruleId,
    ...(['clientAppTypes', 'clientApps', 'countries', 'continents', 'ips', 'urls', 'userAgents', 'parameters'] as const).map(
      (key) => `${key}=${[...(fields[key] as string[])].map((v) => v.toLowerCase()).sort().join('|')}`,
    ),
  ]
  return parts.join(';')
}

/** One live exception's match values, as read from /sites/status → rules[].exceptions[].values[]. */
export interface LiveExceptionValue {
  id?: string
  name?: string
  ips?: string[]
  urls?: Array<{ value?: string; pattern?: string }>
  geo?: { countries?: string[]; continents?: string[] }
  client_apps?: string[]
  client_app_types?: string[]
  parameters?: string[]
  user_agents?: string[]
  [key: string]: unknown
}
export interface LiveException {
  id?: number
  values?: LiveExceptionValue[]
}
export interface StatusRuleWithExceptions {
  id?: string
  exceptions?: LiveException[]
  [key: string]: unknown
}

/** Extract the rules[] array (with exceptions) for a rule family from a /sites/status envelope. */
export function statusRulesFor(status: ImpervaEnvelope | null, family: 'acl' | 'waf'): StatusRuleWithExceptions[] {
  const security = status && typeof status === 'object' ? (status as Record<string, unknown>).security : undefined
  const bucket = security && typeof security === 'object' ? (security as Record<string, unknown>)[family === 'acl' ? 'acls' : 'waf'] : undefined
  const rules = bucket && typeof bucket === 'object' ? (bucket as Record<string, unknown>).rules : undefined
  return Array.isArray(rules) ? (rules as StatusRuleWithExceptions[]) : []
}

/** Convert one live exception's values[] into the same ExceptionFields shape declared items use. */
export function liveExceptionFields(ruleId: string, siteId: string, exception: LiveException): ExceptionFields {
  const fields: ExceptionFields = {
    siteId,
    ruleId,
    clientAppTypes: [],
    clientApps: [],
    countries: [],
    continents: [],
    ips: [],
    urls: [],
    userAgents: [],
    parameters: [],
  }
  for (const value of exception.values ?? []) {
    if (Array.isArray(value.ips)) fields.ips.push(...value.ips.map(String))
    if (Array.isArray(value.urls)) fields.urls.push(...value.urls.map((u) => String(u?.value ?? '')))
    if (value.geo?.countries) fields.countries.push(...value.geo.countries.map(String))
    if (value.geo?.continents) fields.continents.push(...value.geo.continents.map(String))
    if (Array.isArray(value.client_apps)) fields.clientApps.push(...value.client_apps.map(String))
    if (Array.isArray(value.client_app_types)) fields.clientAppTypes.push(...value.client_app_types.map(String))
    if (Array.isArray(value.parameters)) fields.parameters.push(...value.parameters.map(String))
    if (Array.isArray(value.user_agents)) fields.userAgents.push(...value.user_agents.map(String))
  }
  return fields
}
