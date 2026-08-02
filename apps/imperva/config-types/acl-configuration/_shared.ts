// Shared helpers for the Imperva Cloud WAF ACL Configuration config type
// (deploy + rollback + drift). Each item is one site ACL list — blacklisted
// IPs / countries / URLs or whitelisted IPs — SET declaratively over the legacy
// Cloud WAF (Incapsula) v1 API (POST /sites/configure/acl) and read back from
// POST /sites/status (security.acls.rules[]).
//
// IMPORTANT: /sites/configure/acl is a per-site SET — the value submitted for a
// rule id REPLACES the whole list for that ACL type on the site. This config
// type is therefore declarative: the canvas holds the full desired list.
//
// Rule ids, parameters and the URL-pattern enum are taken from Imperva's official
// open-source Terraform provider (incapsula/client_acl_security_rule.go,
// incapsula/client_site.go) and the acl_security_rule docs. FLAG: the exact
// /sites/status security.acls.rules shape is tolerated defensively and should be
// confirmed against a live Imperva account.

import { type ImpervaEnvelope } from '../../lib/impervaApi'

export const BLACKLISTED_IPS = 'api.acl.blacklisted_ips'
export const WHITELISTED_IPS = 'api.acl.whitelisted_ips'
export const BLACKLISTED_COUNTRIES = 'api.acl.blacklisted_countries'
export const BLACKLISTED_URLS = 'api.acl.blacklisted_urls'

export const ACL_RULE_IDS = new Set<string>([BLACKLISTED_IPS, WHITELISTED_IPS, BLACKLISTED_COUNTRIES, BLACKLISTED_URLS])

/** The URL match patterns, positionally paired with the urls list. */
export const URL_PATTERNS = new Set(['CONTAINS', 'EQUALS', 'PREFIX', 'SUFFIX', 'NOT_EQUALS', 'NOT_CONTAIN', 'NOT_PREFIX', 'NOT_SUFFIX'])

export type AclKind = 'ips' | 'geo' | 'urls'

/** Which value family an ACL rule id uses, or null when unknown. */
export function classifyAcl(aclId: string): AclKind | null {
  if (aclId === BLACKLISTED_IPS || aclId === WHITELISTED_IPS) return 'ips'
  if (aclId === BLACKLISTED_COUNTRIES) return 'geo'
  if (aclId === BLACKLISTED_URLS) return 'urls'
  return null
}

/** Coerce a canvas value (a tags array, or a comma/newline-separated string) to a trimmed string list. */
export function toList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(/[\n,]/)
  return raw.map((s) => s.trim()).filter((s) => s.length > 0)
}

export interface AclFields {
  siteId: string
  aclId: string
  ips: string[]
  countries: string[]
  continents: string[]
  urls: string[]
  urlPatterns: string[]
}

/** Read + normalize the canvas fields for one ACL item. */
export function readAclFields(fields: Record<string, unknown>): AclFields {
  return {
    siteId: String(fields.siteId ?? '').trim(),
    aclId: String(fields.aclId ?? '').trim(),
    ips: toList(fields.ips),
    countries: toList(fields.countries),
    continents: toList(fields.continents),
    urls: toList(fields.urls),
    urlPatterns: toList(fields.urlPatterns),
  }
}

/** The full desired value set for one ACL rule (irrelevant families stay empty). */
export interface AclValues {
  ips: string[]
  countries: string[]
  continents: string[]
  urls: string[]
  urlPatterns: string[]
}

/** The desired value set declared by the canvas item. */
export function declaredAclValues(fields: AclFields): AclValues {
  return { ips: fields.ips, countries: fields.countries, continents: fields.continents, urls: fields.urls, urlPatterns: fields.urlPatterns }
}

/**
 * The /sites/configure/acl form parameters for a value set. Mirrors the Imperva
 * Terraform provider exactly: `ips` (IP lists) and `urls` + `url_patterns` (URL
 * lists) are always sent — an empty value clears that list — while `countries` /
 * `continents` are sent only when non-empty. FLAG: because the geo params are
 * omitted when empty, clearing an existing country/continent blacklist through
 * this endpoint is not expressible (matches the provider's behaviour).
 */
export function aclParamsFromValues(kind: AclKind, v: AclValues): Record<string, string> {
  if (kind === 'ips') return { ips: v.ips.join(',') }
  if (kind === 'urls') return { urls: v.urls.join(','), url_patterns: v.urlPatterns.join(',') }
  // geo
  const params: Record<string, string> = {}
  if (v.countries.length) params.countries = v.countries.join(',')
  if (v.continents.length) params.continents = v.continents.join(',')
  return params
}

/**
 * The /sites/configure/acl parameters for RESTORING a prior value set (rollback).
 * Unlike aclParamsFromValues (which mirrors the provider and omits empty geo
 * params), this always sends every parameter for the kind — including empty
 * `countries` / `continents` — so an empty prior set is expressed as a clear.
 * FLAG: clearing a country/continent blacklist by submitting empty geo params is
 * not documented; it is done here to make rollback restore the exact prior state.
 */
export function aclRestoreParams(kind: AclKind, v: AclValues): Record<string, string> {
  if (kind === 'ips') return { ips: v.ips.join(',') }
  if (kind === 'urls') return { urls: v.urls.join(','), url_patterns: v.urlPatterns.join(',') }
  return { countries: v.countries.join(','), continents: v.continents.join(',') }
}

/** One ACL rule as returned inside /sites/status → security.acls.rules[]. */
export interface AclRuleStatus {
  id?: string
  name?: string
  ips?: string[]
  geo?: { countries?: string[]; continents?: string[] }
  urls?: Array<{ value?: string; pattern?: string }>
  [key: string]: unknown
}

/** Extract the ACL rules array from a /sites/status envelope, defensively. */
export function aclRulesFromStatus(status: ImpervaEnvelope | null): AclRuleStatus[] {
  const security = status && typeof status === 'object' ? (status as Record<string, unknown>).security : undefined
  const acls = security && typeof security === 'object' ? (security as Record<string, unknown>).acls : undefined
  const rules = acls && typeof acls === 'object' ? (acls as Record<string, unknown>).rules : undefined
  return Array.isArray(rules) ? (rules as AclRuleStatus[]) : []
}

/** Find the live ACL rule for a rule id (the singleton per site), or null. */
export function findAclRule(rules: AclRuleStatus[], aclId: string): AclRuleStatus | null {
  return rules.find((r) => String(r.id ?? '') === aclId) ?? null
}

/** The live value set for an ACL rule, read from its /sites/status entry. */
export function liveAclValues(rule: AclRuleStatus): AclValues {
  const urls = Array.isArray(rule.urls) ? rule.urls : []
  return {
    ips: Array.isArray(rule.ips) ? rule.ips.map(String) : [],
    countries: Array.isArray(rule.geo?.countries) ? rule.geo!.countries!.map(String) : [],
    continents: Array.isArray(rule.geo?.continents) ? rule.geo!.continents!.map(String) : [],
    urls: urls.map((u) => String(u?.value ?? '')),
    urlPatterns: urls.map((u) => String(u?.pattern ?? '')),
  }
}

/** True when two string lists hold the same values, order-insensitive. */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((v, i) => v === sb[i])
}

/** The `value|pattern` pairs of a URL list, for order-insensitive comparison. */
export function urlPairs(v: AclValues): string[] {
  return v.urls.map((u, i) => `${u}|${v.urlPatterns[i] ?? ''}`)
}
