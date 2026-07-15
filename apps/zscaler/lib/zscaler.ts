// =============================================================================
// Zscaler OneAPI client — speaks to BOTH ZIA and ZPA with one OAuth2 token.
//
// Auth is the Zscaler OneAPI (Zidentity) OAuth2 client-credentials flow:
//   POST https://<vanity>.zslogin.net/oauth2/v1/token
//     grant_type=client_credentials & client_id & client_secret
//     & audience=https://api.zscaler.com
// The returned bearer token works for BOTH products. API calls go to a single
// host (api.zsapi.net for commercial prod), routed by path prefix:
//   ZIA  -> https://api.zsapi.net/zia/api/v1/...
//   ZPA  -> https://api.zsapi.net/zpa/mgmtconfig/v1/admin/customers/{customerId}/...
//
// Two product-specific quirks this client encapsulates:
//   * ZIA STAGES config changes. Writes only take effect after
//     POST /zia/api/v1/status/activate. Deploy handlers write everything, then
//     call activate() ONCE at the end. ZPA changes are immediate (no activate).
//   * ZPA paths embed a customerId (the ZPA tenant id), which is NOT in the
//     token — it is supplied as an app setting.
//
// Handlers run in-process in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency. It never
// throws on an HTTP error status — callers inspect `status` so they can tell a
// 404 (object absent) from a real failure. The token is cached at module scope
// (keyed per tenant) so a burst of handler calls shares one token.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000
/** OneAPI OAuth audience — constant across tenants (per the Zscaler SDKs). */
const OAUTH_AUDIENCE = 'https://api.zscaler.com'
/** Refresh a cached token this many ms before it actually expires. */
const TOKEN_SKEW_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// -----------------------------------------------------------------------------
// Cloud → host resolution. OneAPI collapses the old per-cloud hostnames into a
// single API host plus a Zidentity login host; `cloud` selects the environment.
// -----------------------------------------------------------------------------
interface ZscalerHosts {
  apiHost: string
  loginHost: (vanity: string) => string
}

export function resolveHosts(cloud: string): ZscalerHosts {
  const c = cloud.trim().toLowerCase()
  switch (c) {
    case '':
    case 'production':
    case 'prod':
    case 'commercial':
      return { apiHost: 'api.zsapi.net', loginHost: (v) => `${v}.zslogin.net` }
    case 'gov':
    case 'zscalergov':
      return { apiHost: 'api.zscalergov.net', loginHost: (v) => `${v}.zidentitygov.net` }
    case 'govus':
    case 'zscalergovus':
      return { apiHost: 'api.zscalergov.us', loginHost: (v) => `${v}.zidentitygov.us` }
    default:
      // A named non-prod commercial cloud (e.g. "beta"): api.<cloud>.zsapi.net,
      // login on <vanity>.zslogin<cloud>.net.
      return { apiHost: `api.${c}.zsapi.net`, loginHost: (v) => `${v}.zslogin${c}.net` }
  }
}

export interface ZscalerSettings {
  cloud: string
  /** ZPA tenant id, required for any ZPA config type; null disables ZPA calls. */
  customerId: string | null
  /** Optional ZPA microtenant id, applied as a query filter when set. */
  microtenantId: string | null
  timeoutMs: number
}

export function readZscalerSettings(settings: Record<string, unknown>): ZscalerSettings {
  const rawCloud = settings.cloud
  const cloud = typeof rawCloud === 'string' ? rawCloud.trim() : ''

  const rawCustomer = settings.zpa_customer_id
  const customerId =
    typeof rawCustomer === 'string' && rawCustomer.trim().length > 0 ? rawCustomer.trim() : null

  const rawMicro = settings.zpa_microtenant_id
  const microtenantId =
    typeof rawMicro === 'string' && rawMicro.trim().length > 0 ? rawMicro.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { cloud, customerId, microtenantId, timeoutMs }
}

export interface ZscalerCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the OneAPI client id + secret from a Veltrix credential.
 * Convention: client id in "username"; client secret in "API token" (preferred)
 * or "password".
 */
export function resolveZscalerCredentials(credential: CredentialRef | null): ZscalerCredentials | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Zscaler OneAPI credential available — create an API client in the Zidentity Admin portal ' +
  '(under API Clients) and store its Client ID in the credential "username" field and its Client ' +
  'Secret in the "API token" field. The API client must be granted the ZIA/ZPA roles for what this ' +
  'app manages.'

export const MISSING_CUSTOMER_ID_MESSAGE =
  'No ZPA customer id configured — set the "ZPA Customer ID" app setting (found in the ZPA Admin ' +
  'Portal under Configuration & Control > Public API > API Keys) to manage ZPA configuration.'

export interface ZscalerResponse {
  status: number
  ok: boolean
  body: string
}

export type ZscalerMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface RawResponse extends ZscalerResponse {
  retryAfterMs: number | null
}

// Module-scope token cache, keyed per tenant (never includes the secret).
interface CachedToken {
  token: string
  expiresAt: number
}
const tokenCache = new Map<string, CachedToken>()

export class ZscalerClient {
  private readonly apiHost: string
  private readonly loginUrl: string
  private readonly cacheKey: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly customerId: string | null
  private readonly microtenantId: string | null
  private readonly timeoutMs: number

  constructor(opts: {
    apiHost: string
    loginUrl: string
    cacheKey: string
    clientId: string
    clientSecret: string
    customerId: string | null
    microtenantId: string | null
    timeoutMs: number
  }) {
    this.apiHost = opts.apiHost
    this.loginUrl = opts.loginUrl
    this.cacheKey = opts.cacheKey
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.customerId = opts.customerId
    this.microtenantId = opts.microtenantId
    this.timeoutMs = opts.timeoutMs
  }

  /** True when a ZPA customer id is configured (ZPA calls are usable). */
  get hasCustomerId(): boolean {
    return this.customerId !== null
  }

  // ---- ZIA -----------------------------------------------------------------

  /** A ZIA request under `/zia/api/v1`. */
  async zia(
    method: ZscalerMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<ZscalerResponse> {
    return this.request(method, `/zia/api/v1${path}`, opts)
  }

  /**
   * GET every page of a ZIA collection. ZIA list endpoints accept `page`
   * (1-based) + `pageSize` and return a JSON array; this follows pages until a
   * short page (or the safety cap). Endpoints that ignore paging return their
   * whole array on page 1, which is < pageSize and stops the loop.
   */
  async ziaGetAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    pageSize = 1000,
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let page = 1
    let lastStatus = 0
    let lastBody = ''
    const maxPages = 100
    while (page <= maxPages) {
      const res = await this.zia('GET', path, { query: { ...query, page, pageSize } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const pageItems = parseJson<T[]>(res.body)
      if (!Array.isArray(pageItems) || pageItems.length === 0) break
      items.push(...pageItems)
      if (pageItems.length < pageSize) break
      page++
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  /** Push all pending ZIA changes to production. Call once after all writes. */
  async activate(): Promise<ZscalerResponse> {
    return this.zia('POST', '/status/activate', { body: {} })
  }

  /** Current ZIA activation status ({ status: ACTIVE | PENDING | INPROGRESS }). */
  async activationStatus(): Promise<ZscalerResponse> {
    return this.zia('GET', '/status')
  }

  // ---- ZPA -----------------------------------------------------------------

  /**
   * A ZPA request under `/zpa/mgmtconfig/<version>/admin/customers/{customerId}`.
   * Returns a synthetic error response (never throws) when no customer id is set.
   * A configured microtenant id is appended as a query filter automatically.
   */
  async zpa(
    method: ZscalerMethod,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
      version?: 'v1' | 'v2'
    } = {},
  ): Promise<ZscalerResponse> {
    if (!this.customerId) {
      return {
        status: 0,
        ok: false,
        body: JSON.stringify({ reason: MISSING_CUSTOMER_ID_MESSAGE }),
      }
    }
    const version = opts.version ?? 'v1'
    const base = `/zpa/mgmtconfig/${version}/admin/customers/${encodeURIComponent(this.customerId)}`
    const query = { ...opts.query }
    if (this.microtenantId && query.microtenantId === undefined) query.microtenantId = this.microtenantId
    return this.request(method, `${base}${path}`, { query, body: opts.body })
  }

  /**
   * GET every page of a ZPA collection. ZPA lists accept `page` (1-based) +
   * `pagesize` and return `{ list, totalPages, totalCount }`; this follows pages
   * until `page > totalPages`.
   */
  async zpaGetAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    version: 'v1' | 'v2' = 'v1',
    pageSize = 500,
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let page = 1
    let lastStatus = 0
    let lastBody = ''
    const maxPages = 200
    while (page <= maxPages) {
      const res = await this.zpa('GET', path, { query: { ...query, page, pagesize: pageSize }, version })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const parsed = parseJson<{ list?: T[]; totalPages?: string | number }>(res.body)
      const list = parsed?.list
      if (Array.isArray(list)) items.push(...list)
      const totalPages = parsed?.totalPages !== undefined ? Number(parsed.totalPages) : 1
      if (!Array.isArray(list) || list.length === 0 || page >= (Number.isFinite(totalPages) ? totalPages : 1)) break
      page++
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  // ---- transport -----------------------------------------------------------

  private async request(
    method: ZscalerMethod,
    fullPath: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<ZscalerResponse> {
    let res = await this.authorizedSend(method, fullPath, opts)

    // A cached token can expire mid-flight; drop it and retry once.
    if (res.status === 401) {
      tokenCache.delete(this.cacheKey)
      res = await this.authorizedSend(method, fullPath, opts)
    }

    let attempts = 0
    while (res.status === 429 && attempts < 2) {
      const waitMs = res.retryAfterMs
      if (waitMs === null || waitMs > MAX_RATE_LIMIT_WAIT_MS) break
      await sleep(waitMs > 0 ? waitMs : 1000)
      res = await this.authorizedSend(method, fullPath, opts)
      attempts++
    }

    return { status: res.status, ok: res.ok, body: res.body }
  }

  private async authorizedSend(
    method: ZscalerMethod,
    fullPath: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<RawResponse> {
    const token = await this.getToken()
    if ('error' in token) {
      return { status: 0, ok: false, body: JSON.stringify({ reason: token.error }), retryAfterMs: null }
    }

    const url = new URL(`https://${this.apiHost}${fullPath}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        body: text,
        retryAfterMs: rateLimitWaitMs(res.headers),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async getToken(): Promise<{ token: string } | { error: string }> {
    const cached = tokenCache.get(this.cacheKey)
    const now = Date.now()
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > now) return { token: cached.token }

    const form = new URLSearchParams()
    form.set('grant_type', 'client_credentials')
    form.set('client_id', this.clientId)
    form.set('client_secret', this.clientSecret)
    form.set('audience', OAUTH_AUDIENCE)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: controller.signal,
      })
      const text = await res.text()
      if (res.status < 200 || res.status >= 300) {
        return { error: `Zscaler OneAPI token request failed (HTTP ${res.status}). ${tokenErrorHint(text)}` }
      }
      const parsed = parseJson<{ access_token?: string; expires_in?: number }>(text)
      if (!parsed?.access_token) return { error: 'Zscaler OneAPI token response did not contain an access_token.' }
      const ttlMs = parsed.expires_in && parsed.expires_in > 0 ? parsed.expires_in * 1000 : 3_600_000
      tokenCache.set(this.cacheKey, { token: parsed.access_token, expiresAt: now + ttlMs })
      return { token: parsed.access_token }
    } catch (err) {
      return { error: `Zscaler OneAPI token request error: ${(err as Error).message}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Prefer Retry-After (seconds), fall back to X-RateLimit-Reset (seconds). */
function rateLimitWaitMs(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  }
  const reset = headers.get('x-ratelimit-reset')
  if (reset) {
    const secs = Number(reset)
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  }
  return null
}

function tokenErrorHint(body: string): string {
  const parsed = parseJson<{ error?: string; error_description?: string; message?: string }>(body)
  const detail = parsed?.error_description || parsed?.error || parsed?.message
  return detail ? String(detail) : 'Check the Client ID/Secret, the vanity domain (component hostname) and the cloud setting.'
}

/** Build a client from a component hostname (the Zidentity vanity domain), a credential and settings. */
export function buildZscalerClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: ZscalerClient; vanity: string } | { error: string } {
  const creds = resolveZscalerCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const vanity = normalizeVanity(hostname)
  if (!vanity) {
    return {
      error:
        'No Zscaler tenant — register a component whose hostname is your Zidentity vanity domain ' +
        '(the tenant subdomain, e.g. "acme" or "acme.zslogin.net").',
    }
  }

  const resolved = readZscalerSettings(settings)
  const hosts = resolveHosts(resolved.cloud)
  const loginUrl = `https://${hosts.loginHost(vanity)}/oauth2/v1/token`

  return {
    client: new ZscalerClient({
      apiHost: hosts.apiHost,
      loginUrl,
      cacheKey: `${vanity}|${creds.clientId}|${hosts.apiHost}`,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      customerId: resolved.customerId,
      microtenantId: resolved.microtenantId,
      timeoutMs: resolved.timeoutMs,
    }),
    vanity,
  }
}

/** Reduce a hostname to the vanity label: strips protocol/path and any domain suffix. */
export function normalizeVanity(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim()
  if (!host) return null
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  // "acme.zslogin.net" -> "acme"; "acme" -> "acme".
  const label = host.split('.')[0]
  return label.length > 0 ? label : null
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from a ZIA/ZPA error response body. */
export function zscalerErrorMessage(res: ZscalerResponse): string {
  const parsed = parseJson<{
    message?: string
    reason?: string
    // ZIA validation errors
    code?: string
    // ZPA errors: { id, reason } or { params, reason }
    id?: string
  }>(res.body)
  if (parsed?.message) return parsed.message
  if (parsed?.reason) return parsed.reason
  if (parsed?.code) return parsed.code
  return res.body || `HTTP ${res.status}`
}
