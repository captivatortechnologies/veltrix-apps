// Shared helpers for the Imperva Cloud WAF Site Configuration config type
// (deploy + rollback + drift). Each item is a site's GENERAL settings — the
// per-site options exposed by the legacy Cloud WAF (Incapsula) management API
// v1's single-param/value site update endpoint, plus the site's log level (a
// sibling call). SET declaratively, one item per site:
//   POST /sites/configure  { site_id, param, value }   (one call PER changed param)
//   POST /sites/setlog     { site_id, log_level, logs_account_id }
//
// Params + their value sets are taken from Imperva's official open-source
// Terraform provider (incapsula/resource_site.go — see the `updateParams` list
// and the `active`/`domain_validation`/`acceleration_level`/`seal_location`/
// `restricted_cname_reuse` schema descriptions — and client_log_level.go). FLAG:
// `/sites/status` only echoes back SOME of these params (active,
// acceleration_level, ref_id, restricted_cname_reuse, naked_domain_san,
// wildcard_san, seal location, log_level) — the rest (domain_validation,
// approver, ignore_ssl, domain_redirect_to_full) are WRITE-ONLY on this API:
// deploy can SET them but cannot read back a prior value, so rollback cannot
// restore them (the same "write-only field" caveat this app already documents
// for other one-way settings) — verify against a live Imperva account.
//
// `remove_ssl` (documented as "true or empty string") is deliberately NOT
// modeled — unlike every other param here it reads as a one-shot ACTION ("strip
// Imperva-managed SSL from this site") rather than durable state, and applying
// it declaratively on every deploy would be actively dangerous.

import { type ImpervaEnvelope } from '../../lib/impervaApi'

export const ACTIVE_VALUES = new Set(['active', 'bypass'])
export const DOMAIN_VALIDATION_VALUES = new Set(['email', 'html', 'dns', 'cname'])
export const ACCELERATION_LEVELS = new Set(['none', 'standard', 'aggressive'])
export const SEAL_LOCATIONS = new Set([
  'api.seal_location.none',
  'api.seal_location.bottom_left',
  'api.seal_location.bottom_right',
  'api.seal_location.bottom',
  'api.seal_location.left',
  'api.seal_location.right',
  'api.seal_location.right_bottom',
])
export const LOG_LEVELS = new Set(['full', 'security', 'none'])
export const BOOL_STRINGS = new Set(['true', 'false'])

export interface SiteConfigFields {
  siteId: string
  active: string
  domainValidation: string
  approver: string
  ignoreSsl: string
  accelerationLevel: string
  sealLocation: string
  restrictedCnameReuse: string
  domainRedirectToFull: string
  refId: string
  nakedDomainSan: string
  wildcardSan: string
  logLevel: string
  logsAccountId: string
}

/** Read + trim the canvas fields for one site configuration item. */
export function readSiteConfigFields(fields: Record<string, unknown>): SiteConfigFields {
  const s = (k: string) => String(fields[k] ?? '').trim()
  return {
    siteId: s('siteId'),
    active: s('active'),
    domainValidation: s('domainValidation'),
    approver: s('approver'),
    ignoreSsl: s('ignoreSsl'),
    accelerationLevel: s('accelerationLevel'),
    sealLocation: s('sealLocation'),
    restrictedCnameReuse: s('restrictedCnameReuse'),
    domainRedirectToFull: s('domainRedirectToFull'),
    refId: s('refId'),
    nakedDomainSan: s('nakedDomainSan'),
    wildcardSan: s('wildcardSan'),
    logLevel: s('logLevel'),
    logsAccountId: s('logsAccountId'),
  }
}

/**
 * Map of canvas field → the `/sites/configure` `param` name it sets. Every
 * declared (non-empty) field here is sent as its OWN `POST /sites/configure`
 * call — the API takes one param/value pair per request, mirroring how
 * Imperva's own Terraform provider diffs and applies these one at a time.
 */
export const SITE_CONFIGURE_PARAM_NAMES: Record<string, string> = {
  active: 'active',
  domainValidation: 'domain_validation',
  approver: 'approver',
  ignoreSsl: 'ignore_ssl',
  accelerationLevel: 'acceleration_level',
  sealLocation: 'seal_location',
  restrictedCnameReuse: 'restricted_cname_reuse',
  domainRedirectToFull: 'domain_redirect_to_full',
  refId: 'ref_id',
  nakedDomainSan: 'naked_domain_san',
  wildcardSan: 'wildcard_san',
}

/** The declared (non-empty) `{ param, value }` pairs to SET via /sites/configure. */
export function declaredConfigureParams(fields: SiteConfigFields): Array<{ param: string; value: string }> {
  const out: Array<{ param: string; value: string }> = []
  for (const [fieldKey, param] of Object.entries(SITE_CONFIGURE_PARAM_NAMES)) {
    const value = (fields as unknown as Record<string, string>)[fieldKey]
    if (value !== '') out.push({ param, value })
  }
  return out
}

/** Fields with a confirmed read-back on `/sites/status` (see liveSiteConfigValues). */
export const READABLE_FIELDS = new Set(['active', 'accelerationLevel', 'refId', 'restrictedCnameReuse', 'nakedDomainSan', 'wildcardSan', 'sealLocation'])

/** The subset of `/sites/status` this config type reads back, for prior-value capture + drift. */
export interface SiteStatusForConfig {
  active?: string
  acceleration_level?: string
  ref_id?: string
  restricted_cname_reuse?: boolean | string
  add_naked_domain_san?: boolean | string
  use_wildcard_san_instead_of_full_domain_san?: boolean | string
  sealLocation?: { id?: string }
  log_level?: string
  [key: string]: unknown
}

/** Normalize a boolean-ish status value to 'true' / 'false'. */
export function boolToStr(value: unknown): string {
  if (typeof value === 'boolean') return String(value)
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' ? 'true' : 'false'
}

/** The live values for every READABLE field, read from a `/sites/status` envelope. */
export function liveSiteConfigValues(status: ImpervaEnvelope | SiteStatusForConfig | null): Record<string, string> {
  if (!status || typeof status !== 'object') return {}
  const s = status as SiteStatusForConfig
  return {
    active: String(s.active ?? ''),
    accelerationLevel: String(s.acceleration_level ?? ''),
    refId: String(s.ref_id ?? ''),
    restrictedCnameReuse: boolToStr(s.restricted_cname_reuse),
    nakedDomainSan: boolToStr(s.add_naked_domain_san),
    wildcardSan: boolToStr(s.use_wildcard_san_instead_of_full_domain_san),
    sealLocation: String(s.sealLocation?.id ?? ''),
    logLevel: String(s.log_level ?? ''),
  }
}
