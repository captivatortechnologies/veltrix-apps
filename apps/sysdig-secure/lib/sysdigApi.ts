// =============================================================================
// Sysdig Secure access seam.
//
// One path: HTTPS REST against the Sysdig Secure API. Sysdig is SaaS with a
// valid TLS certificate, so this uses the platform's global `fetch` (no
// self-signed handling needed, unlike MISP).
//
// Auth is a Bearer API token carried in the Authorization header:
//   Authorization: Bearer <SYSDIG_SECURE_API_TOKEN>
// The token is stored as the connection credential's apiToken. It can be a
// user API token, a team-based service account or a global service account.
//
// Base URL is the REGION base URL supplied on the connection (component
// endpoint / hostname), e.g. https://us2.app.sysdig.com. The default
// (us-east-1) is https://secure.sysdig.com — the same default the official
// Terraform provider uses (SYSDIG_SECURE_URL).
//
// Custom Falco rules are individual objects under /api/secure/rules:
//   list-by-name:  GET    /api/secure/rules/groups?name=<name>&type=FALCO
//   create:        POST   /api/secure/rules?skipPolicyV2Msg=true
//   get by id:     GET    /api/secure/rules/<id>
//   update:        PUT    /api/secure/rules/<id>?skipPolicyV2Msg=true
//   delete:        DELETE /api/secure/rules/<id>?skipPolicyV2Msg=true
// (Endpoint paths + rule shape confirmed against the official
// terraform-provider-sysdig client — verify against a live Sysdig Secure.)
//
// Three further object families are managed the same way (v0.2.0), each with a
// name-keyed upsert. Endpoints confirmed against terraform-provider-sysdig
// (CRUD by id) AND the official python-sdc-client (the by-name "group" lookup):
//   runtime policies  → /api/v2/policies            (list-all + id CRUD; no by-name)
//   falco lists       → /api/secure/falco/lists     (id CRUD) + /groups?name= lookup
//   falco macros      → /api/secure/falco/macros     (id CRUD) + /groups?name= lookup
// NOTE these differ from the informal paths in the task brief: policies live at
// /api/v2/policies (not /api/policies/v2), and lists/macros have their own
// endpoints (not /api/secure/rules?type=FALCO_LIST|FALCO_MACRO). Verify live.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** Sysdig Secure rule type discriminator for custom Falco rules. */
export const FALCO_RULE_TYPE = 'FALCO'

/** Default per-request timeout for Sysdig Secure API calls. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** us-east-1 default base URL — matches the Terraform provider's SYSDIG_SECURE_URL default. */
export const DEFAULT_SYSDIG_BASE_URL = 'https://secure.sysdig.com'

/**
 * Known Sysdig SaaS region base URLs, for Setup-guide / helper text only. The
 * connection stores the FULL base URL, so an unlisted region still works — the
 * exact per-region hostname is shown in the browser address bar of the Sysdig
 * console and in the Sysdig "SaaS Regions and IP Ranges" doc.
 */
export const SYSDIG_REGION_BASE_URLS: Record<string, string> = {
  'us-east-1': 'https://secure.sysdig.com',
  'us-west-2': 'https://us2.app.sysdig.com',
  'us4-gcp': 'https://app.us4.sysdig.com',
  'eu-central-1': 'https://eu1.app.sysdig.com',
  'au-southeast-1': 'https://app.au1.sysdig.com',
}

/** Read the request timeout (ms) from app settings, falling back to the default. */
export function readTimeoutMs(settings: Record<string, unknown> | undefined): number {
  const raw = settings?.request_timeout_seconds
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw * 1000
  return DEFAULT_TIMEOUT_MS
}

/**
 * Normalize a raw region base URL / host into an https base URL with no trailing
 * slash. Accepts a full URL ("https://us2.app.sysdig.com"), a bare host
 * ("us2.app.sysdig.com") or an http URL (upgraded to https).
 */
export function resolveSysdigBaseUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const withScheme = /^https?:\/\//i.test(value) ? value.replace(/^http:\/\//i, 'https://') : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * Sysdig authorization header — the API token as a Bearer credential. Returns an
 * empty object when no token is present; callers require a credential before
 * applying anything.
 */
export function buildAuthHeader(credential: CredentialRef | null): Record<string, string> {
  const token = credential?.apiToken?.trim()
  if (token) return { Authorization: `Bearer ${token}` }
  return {}
}

// --- Rule model (mirror of the Sysdig Secure /api/secure/rules JSON) ----------

/** Falco condition object: the Falco filter expression plus opaque UI components. */
export interface FalcoCondition {
  condition: string
  components?: unknown[]
}

/** The `details` block of a FALCO rule. */
export interface FalcoRuleDetails {
  ruleType: string
  source?: string
  output?: string
  condition?: FalcoCondition
  priority?: string
  append?: boolean
  exceptions?: unknown[]
  minimumEngineVersion?: number
  [key: string]: unknown
}

/** One Sysdig Secure custom Falco rule. */
export interface SysdigRule {
  id?: number
  name: string
  description?: string
  tags?: string[]
  version?: number
  details: FalcoRuleDetails
  [key: string]: unknown
}

export interface SysdigResponse {
  status: number
  ok: boolean
  body: string
}

// --- Runtime policy model (mirror of the Sysdig Secure /api/v2/policies JSON) --

/**
 * A response action carried by a policy. For rule-referencing runtime policies
 * the meaningful ones are notify-only (empty), STOP, PAUSE and KILL; CAPTURE
 * additionally needs bucket/file fields, so this app does not emit it.
 */
export interface PolicyAction {
  type: string
  [key: string]: unknown
}

/** One Sysdig Secure runtime policy (type "falco" — references rules by name). */
export interface SysdigPolicy {
  id?: number
  name: string
  description?: string
  enabled?: boolean
  /** 0–7, syslog levels (0 = EMERGENCY … 7 = DEBUG); lower = more severe. */
  severity?: number
  ruleNames?: string[]
  actions?: PolicyAction[]
  scope?: string
  type?: string
  version?: number
  notificationChannelIds?: number[]
  [key: string]: unknown
}

// --- Falco list model (mirror of the Sysdig Secure /api/secure/falco/lists JSON)

/** The `items` block of a Falco list — a named set of literals. */
export interface SysdigListItems {
  items: string[]
}

/** One custom Falco list. */
export interface SysdigList {
  id?: number
  version?: number
  name: string
  items: SysdigListItems
  append?: boolean
  [key: string]: unknown
}

// --- Falco macro model (mirror of the /api/secure/falco/macros JSON) -----------

/** The `condition` block of a Falco macro — a reusable filter expression. */
export interface MacroCondition {
  condition: string
}

/** One custom Falco macro. */
export interface SysdigMacro {
  id?: number
  version?: number
  name: string
  condition: MacroCondition
  append?: boolean
  minimumEngineVersion?: number
  [key: string]: unknown
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/**
 * Thin Sysdig Secure REST client: Bearer auth, JSON, bounded timeout. Never
 * throws on HTTP error statuses — callers inspect `status` so they can
 * distinguish 404 (missing rule) from auth failures. Throws only on network
 * errors / timeout.
 */
export class SysdigClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credential: CredentialRef | null; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.headers = buildAuthHeader(opts.credential)
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Whether an auth token was resolved from the credential. */
  hasAuth(): boolean {
    return Boolean(this.headers.Authorization)
  }

  async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<SysdigResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          ...this.headers,
          Accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Find custom Falco rules by exact name via the rule-group endpoint. Returns
   * the matching rules (usually 0 or 1) — the identity used for upsert.
   */
  async listRulesByName(name: string): Promise<SysdigRule[]> {
    const res = await this.request('GET', '/api/secure/rules/groups', {
      query: { name, type: FALCO_RULE_TYPE },
    })
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`GET /api/secure/rules/groups → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    const parsed = parseJson<SysdigRule[]>(res.body)
    return Array.isArray(parsed) ? parsed : []
  }

  async createRule(rule: SysdigRule): Promise<SysdigRule> {
    const res = await this.request('POST', '/api/secure/rules', { query: { skipPolicyV2Msg: true }, body: rule })
    if (!res.ok) throw new Error(`POST /api/secure/rules → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigRule>(res.body) ?? rule
  }

  async updateRule(id: number, rule: SysdigRule): Promise<SysdigRule> {
    const res = await this.request('PUT', `/api/secure/rules/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
      body: rule,
    })
    if (!res.ok) throw new Error(`PUT /api/secure/rules/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigRule>(res.body) ?? rule
  }

  async deleteRule(id: number): Promise<void> {
    const res = await this.request('DELETE', `/api/secure/rules/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
    })
    // 204 (No Content) and 200 both mean success.
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`DELETE /api/secure/rules/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Runtime policies (/api/v2/policies) ------------------------------------
  // No by-name endpoint exists — callers list all and match on name.

  async listPolicies(): Promise<SysdigPolicy[]> {
    const res = await this.request('GET', '/api/v2/policies')
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`GET /api/v2/policies → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    const parsed = parseJson<SysdigPolicy[]>(res.body)
    return Array.isArray(parsed) ? parsed : []
  }

  async createPolicy(policy: SysdigPolicy): Promise<SysdigPolicy> {
    const res = await this.request('POST', '/api/v2/policies', { query: { skipPolicyV2Msg: true }, body: policy })
    if (!res.ok) throw new Error(`POST /api/v2/policies → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigPolicy>(res.body) ?? policy
  }

  async updatePolicy(id: number, policy: SysdigPolicy): Promise<SysdigPolicy> {
    const res = await this.request('PUT', `/api/v2/policies/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
      body: policy,
    })
    if (!res.ok) throw new Error(`PUT /api/v2/policies/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigPolicy>(res.body) ?? policy
  }

  async deletePolicy(id: number): Promise<void> {
    const res = await this.request('DELETE', `/api/v2/policies/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
    })
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`DELETE /api/v2/policies/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Falco lists (/api/secure/falco/lists) ----------------------------------

  /** Find custom Falco lists by exact name via the list-group endpoint. */
  async listFalcoListsByName(name: string): Promise<SysdigList[]> {
    const res = await this.request('GET', '/api/secure/falco/lists/groups', { query: { name } })
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`GET /api/secure/falco/lists/groups → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    const parsed = parseJson<SysdigList[]>(res.body)
    return Array.isArray(parsed) ? parsed : []
  }

  async createFalcoList(list: SysdigList): Promise<SysdigList> {
    const res = await this.request('POST', '/api/secure/falco/lists', { query: { skipPolicyV2Msg: true }, body: list })
    if (!res.ok) throw new Error(`POST /api/secure/falco/lists → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigList>(res.body) ?? list
  }

  async updateFalcoList(id: number, list: SysdigList): Promise<SysdigList> {
    const res = await this.request('PUT', `/api/secure/falco/lists/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
      body: list,
    })
    if (!res.ok) throw new Error(`PUT /api/secure/falco/lists/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigList>(res.body) ?? list
  }

  async deleteFalcoList(id: number): Promise<void> {
    const res = await this.request('DELETE', `/api/secure/falco/lists/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
    })
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`DELETE /api/secure/falco/lists/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Falco macros (/api/secure/falco/macros) --------------------------------

  /** Find custom Falco macros by exact name via the macro-group endpoint. */
  async listFalcoMacrosByName(name: string): Promise<SysdigMacro[]> {
    const res = await this.request('GET', '/api/secure/falco/macros/groups', { query: { name } })
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`GET /api/secure/falco/macros/groups → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    const parsed = parseJson<SysdigMacro[]>(res.body)
    return Array.isArray(parsed) ? parsed : []
  }

  async createFalcoMacro(macro: SysdigMacro): Promise<SysdigMacro> {
    const res = await this.request('POST', '/api/secure/falco/macros', { query: { skipPolicyV2Msg: true }, body: macro })
    if (!res.ok) throw new Error(`POST /api/secure/falco/macros → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigMacro>(res.body) ?? macro
  }

  async updateFalcoMacro(id: number, macro: SysdigMacro): Promise<SysdigMacro> {
    const res = await this.request('PUT', `/api/secure/falco/macros/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
      body: macro,
    })
    if (!res.ok) throw new Error(`PUT /api/secure/falco/macros/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<SysdigMacro>(res.body) ?? macro
  }

  async deleteFalcoMacro(id: number): Promise<void> {
    const res = await this.request('DELETE', `/api/secure/falco/macros/${encodeURIComponent(String(id))}`, {
      query: { skipPolicyV2Msg: true },
    })
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`DELETE /api/secure/falco/macros/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }
}

/** Build a SysdigClient from handler context pieces, or the reason it cannot be built. */
export function buildSysdigClient(
  endpoint: string | null,
  credential: CredentialRef | null,
  settings?: Record<string, unknown>,
): { client: SysdigClient; baseUrl: string } | { error: string } {
  const baseUrl = resolveSysdigBaseUrl(endpoint)
  if (!baseUrl) return { error: 'No region base URL is configured for this Sysdig Secure connection.' }
  if (!credential?.apiToken?.trim()) {
    return { error: 'Sysdig Secure authenticates with a Bearer API token — attach one to this connection.' }
  }
  return {
    client: new SysdigClient({ baseUrl, credential, timeoutMs: readTimeoutMs(settings) }),
    baseUrl,
  }
}
