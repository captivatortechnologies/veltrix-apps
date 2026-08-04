// =============================================================================
// Imperva Cloud WAF (Incapsula) access seam — legacy management API v1 client.
//
// Auth + transport (LEGACY Cloud WAF / Incapsula API, v1):
//   base URL : https://my.imperva.com/api/prov/v1   (fixed default; overridable
//              per connection so a non-default management host can be targeted)
//   auth     : `api_id` + `api_key` sent as POST form parameters on EVERY call
//   verbs    : every v1 endpoint is a POST with an
//              `application/x-www-form-urlencoded` body; responses are JSON
//   envelope : the v1 API returns HTTP 200 with a `res` integer status in the
//              body — `res === 0` means success, any other value is an API-level
//              error carried in `res_message` (an HTTP 200 does NOT imply success)
//
// The newer Imperva platform (https://api.imperva.com, `x-API-Id` / `x-API-Key`
// headers) is a separate surface; this app deliberately targets the legacy v1
// management API because it is the confirmed writable surface for site security
// (IncapRules) ACL rules — POST /sites/incapRules/{add,edit,delete,list}.
//
// my.imperva.com serves a public-CA certificate on 443, so the global `fetch`
// transport is used (no self-signed handling needed).
//
// Endpoint + parameter shapes verified against Imperva's official open-source
// Terraform provider (github.com/imperva/terraform-provider-incapsula:
// incapsula/client_incap_rule.go, website/docs/r/incap_rule.html.markdown) and
// Imperva's Cloud Application Security Sites API docs. The exact v1 list-response
// envelope for incapRules is tolerated defensively (see rulesFromResponse) and
// should be confirmed against a live Imperva account.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** Fixed default base URL for the legacy Cloud WAF (Incapsula) management API v1. */
export const DEFAULT_IMPERVA_BASE_URL = 'https://my.imperva.com/api/prov/v1'

/**
 * IncapRules endpoints, relative to the v1 base URL. IncapRules is a single
 * underlying resource — one flat, per-site rule list — reused by TWO config
 * types over its `action` value:
 *   acl-rules       → the SECURITY actions (RULE_ACTION_BLOCK, _ALERT, ...)
 *   delivery-rules  → the DELIVERY/rewrite actions (RULE_ACTION_REDIRECT,
 *                     _REWRITE_URL, _RATE, ...)
 * Both upsert by rule NAME within a site over the same add/edit/delete/list
 * calls; see rulesFromResponse / ruleIdOf / findRule below.
 */
export const INCAP_RULES_ADD_PATH = '/sites/incapRules/add'
export const INCAP_RULES_EDIT_PATH = '/sites/incapRules/edit'
export const INCAP_RULES_DELETE_PATH = '/sites/incapRules/delete'
export const INCAP_RULES_LIST_PATH = '/sites/incapRules/list'

/**
 * Site general configuration — single param/value settings applied one at a time
 * (mirrors Imperva's own Terraform provider, which diffs and sends only the
 * params that changed). `SITE_LOG_LEVEL_PATH` is a sibling endpoint for the one
 * general setting (`log_level` + `logs_account_id`) that has its own call.
 */
export const SITE_CONFIGURE_PATH = '/sites/configure'
export const SITE_LOG_LEVEL_PATH = '/sites/setlog'

/**
 * WAF / ACL rule exceptions ("whitelists") — allow specific match conditions
 * (IPs, countries, URLs, user agents, client apps, request parameters) to bypass
 * ONE specific security or ACL rule on a site. Distinct from ACL Configuration
 * (`ACL_CONFIGURE_PATH`), which blacklists/whitelists site-wide rather than
 * excepting a single rule. add/edit/delete all POST to the same endpoint; list
 * reads back from `/sites/status` (`security.waf.rules[].exceptions[]` /
 * `security.acls.rules[].exceptions[]`).
 */
export const SECURITY_EXCEPTION_CONFIGURE_PATH = '/sites/configure/whitelists'

/**
 * Data Centers (origin server pools) and the individual origin servers within
 * them. A data center is a named pool of one or more origin servers; `add`
 * creates the pool together with its first server, `dataCenters/servers/add`
 * adds additional servers to an existing pool.
 */
export const DATA_CENTER_ADD_PATH = '/sites/dataCenters/add'
export const DATA_CENTER_EDIT_PATH = '/sites/dataCenters/edit'
export const DATA_CENTER_DELETE_PATH = '/sites/dataCenters/delete'
export const DATA_CENTER_LIST_PATH = '/sites/dataCenters/list'
export const DATA_CENTER_SERVER_ADD_PATH = '/sites/dataCenters/servers/add'
export const DATA_CENTER_SERVER_EDIT_PATH = '/sites/dataCenters/servers/edit'
export const DATA_CENTER_SERVER_DELETE_PATH = '/sites/dataCenters/servers/delete'

/**
 * Per-site declarative security / ACL configuration endpoints. Unlike IncapRules
 * (add/edit/delete by rule), each of these SETS one singleton config on a site
 * keyed by `rule_id`, so a deploy reads the prior value from /sites/status, POSTs
 * the new value, and rollback re-POSTs the prior value.
 *   security  → POST /sites/configure/security  { site_id, rule_id, ... }
 *   acl       → POST /sites/configure/acl        { site_id, rule_id, ... }
 * The current values of both are read back from the site status response.
 */
export const SECURITY_CONFIGURE_PATH = '/sites/configure/security'
export const ACL_CONFIGURE_PATH = '/sites/configure/acl'
export const SITE_STATUS_PATH = '/sites/status'

/** Account details endpoint — used to verify credentials + reachability. */
export const ACCOUNT_PATH = '/account'

export const MISSING_CREDENTIAL_MESSAGE =
  'Imperva Cloud WAF authenticates with an API ID and an API key. Attach a credential ' +
  'carrying the API ID (as the username) and the API key (as the API token).'

// --- Credential mapping -------------------------------------------------------

export interface ImpervaCredentials {
  apiId: string
  apiKey: string
}

/**
 * Extract the Imperva API credentials from a Veltrix credential. Convention:
 * `api_id` in `username`, `api_key` in `apiToken`. Returns null when either is
 * missing.
 */
export function resolveImpervaCredentials(credential: CredentialRef | null): ImpervaCredentials | null {
  if (!credential) return null
  const apiId = credential.username?.trim()
  const apiKey = credential.apiToken?.trim()
  if (!apiId || !apiKey) return null
  return { apiId, apiKey }
}

/**
 * Normalize a connection endpoint into a v1 base URL. The base URL is FIXED by
 * default (my.imperva.com/api/prov/v1) but a connection may override it:
 *   - empty / not set        → the default base URL
 *   - already an /api/prov/vN URL → used as-is (trailing slash stripped)
 *   - a bare host or host URL → `https://<host>/api/prov/v1`
 */
export function buildImpervaBaseUrl(endpoint?: string | null): string {
  const raw = (endpoint ?? '').trim()
  if (!raw) return DEFAULT_IMPERVA_BASE_URL
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const trimmed = withScheme.replace(/\/+$/, '')
  if (/\/api\/prov\/v\d+/i.test(trimmed)) return trimmed
  const host = trimmed.replace(/^https?:\/\//i, '').split('/')[0]
  return `https://${host}/api/prov/v1`
}

// --- REST client --------------------------------------------------------------

export interface ImpervaResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * A thin form-POST client for the legacy Cloud WAF v1 API. Every call carries the
 * `api_id` + `api_key` credentials plus the endpoint-specific parameters as an
 * `application/x-www-form-urlencoded` body. Never throws on HTTP error statuses —
 * callers inspect `status` (and the `res` envelope) — and throws only on network
 * errors and timeout.
 */
export class ImpervaClient {
  private readonly baseUrl: string
  private readonly credentials: ImpervaCredentials
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: ImpervaCredentials; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.credentials = opts.credentials
    this.timeoutMs = opts.timeoutMs
  }

  async post(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<ImpervaResponse> {
    const body = new URLSearchParams()
    body.set('api_id', this.credentials.apiId)
    body.set('api_key', this.credentials.apiKey)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build an ImpervaClient from handler context pieces, or return the reason it
 * cannot be built. Deploy-family handlers all start with this.
 */
export function buildImpervaClient(
  endpoint: string | null | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: ImpervaClient; baseUrl: string } | { error: string } {
  const credentials = resolveImpervaCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }
  const baseUrl = buildImpervaBaseUrl(endpoint)
  return { client: new ImpervaClient({ baseUrl, credentials, timeoutMs: readTimeoutMs(settings) }), baseUrl }
}

/** Read the request timeout setting (seconds → ms), defaulting to 30s. */
export function readTimeoutMs(settings: Record<string, unknown>): number {
  const raw = settings.request_timeout_seconds
  const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 30
  return seconds * 1000
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** The common v1 response envelope: `res === 0` is success. */
export interface ImpervaEnvelope {
  res?: number | string
  res_message?: string
  [key: string]: unknown
}

/** True when a parsed v1 response reports success (`res === 0`). */
export function isApiSuccess(payload: ImpervaEnvelope | null): boolean {
  if (!payload) return false
  return payload.res === 0 || payload.res === '0'
}

/**
 * ACL configure success. The `/sites/configure/acl` endpoint reports success with
 * `res === 0` OR `res === 2` — Imperva's own Terraform provider treats both as
 * success for this endpoint (2 is returned when the submitted ACL set is accepted
 * as-is / no effective change). FLAG: the exact meaning of res=2 is taken from the
 * provider source and is not documented in the public API reference.
 */
export function isAclApiSuccess(payload: ImpervaEnvelope | null): boolean {
  if (!payload) return false
  return payload.res === 0 || payload.res === '0' || payload.res === 2 || payload.res === '2'
}

/**
 * Read one site's status (POST /sites/status { site_id }) and return the parsed
 * v1 envelope, or throw with a descriptive message. The site status carries the
 * live `security.waf.rules` and `security.acls.rules` this app reconciles, so it
 * is the read-side for both the security-rules and acl-configuration config types
 * (deploy reads the prior value from it; drift compares against it).
 */
export async function fetchSiteStatus(client: ImpervaClient, siteId: string): Promise<ImpervaEnvelope> {
  const res = await client.post(SITE_STATUS_PATH, { site_id: siteId })
  const json = parseJson<ImpervaEnvelope>(res.body)
  if (!res.ok || !isApiSuccess(json)) {
    throw new Error(`site status for ${siteId} → HTTP ${res.status}: ${apiMessage(json)}`)
  }
  return json as ImpervaEnvelope
}

/** The human-readable status message from a v1 response, or a fallback. */
export function apiMessage(payload: ImpervaEnvelope | null): string {
  if (!payload) return 'no/invalid response body'
  const res = payload.res ?? '?'
  return payload.res_message ? `${payload.res_message} (res=${res})` : `res=${res}`
}

// --- IncapRules (shared by acl-rules + delivery-rules) ------------------------

/** One IncapRule as returned by the v1 API — the fields common to every action kind. */
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
