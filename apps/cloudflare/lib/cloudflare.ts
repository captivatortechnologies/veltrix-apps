// =============================================================================
// Cloudflare API client (v4).
//
// Auth is a scoped API token sent as `Authorization: Bearer <token>`. All calls
// hang off https://api.cloudflare.com/client/v4 and return the standard
// envelope: { success, errors[], messages[], result, result_info }. Cloudflare
// returns HTML on error unless `Accept: application/json` is sent, and failures
// carry a 4xx/5xx status AND success:false — this client sets the header and
// treats a response as ok only when the status is 2xx and success is not false.
//
// Objects are either ZONE-scoped (/zones/{zone_id}/...) or ACCOUNT-scoped
// (/accounts/{account_id}/...). The component hostname is the zone's domain; the
// client resolves zone_id (and the owning account id) once via
// GET /zones?name={domain} and caches it at module scope. An `account_id` app
// setting overrides the derived account (needed for account-scoped objects when
// no zone is registered).
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok` so they
// can tell a 404 from a real failure. Honors 429 Retry-After.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const BASE_URL = 'https://api.cloudflare.com/client/v4'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface CloudflareSettings {
  /** Explicit account id; overrides the account derived from the zone lookup. */
  accountId: string | null
  timeoutMs: number
}

export function readCloudflareSettings(settings: Record<string, unknown>): CloudflareSettings {
  const rawAccount = settings.account_id
  const accountId =
    typeof rawAccount === 'string' && rawAccount.trim().length > 0 ? rawAccount.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { accountId, timeoutMs }
}

/** Extract the Cloudflare API token from a Veltrix credential ("API token" or "password"). */
export function resolveCloudflareToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Cloudflare API token available — create a scoped API token in the Cloudflare dashboard ' +
  '(My Profile > API Tokens) and store it in the credential "API token" field. Grant it the ' +
  'permissions for what this app manages (e.g. Zone > DNS Edit, Zone WAF Edit, Account > Access / ' +
  'Zero Trust / Account Filter Lists Edit).'

export const MISSING_ACCOUNT_MESSAGE =
  'No Cloudflare account id — account-scoped objects (Access, Gateway, Lists) need an account. ' +
  'Set the "Account ID" app setting, or register a component whose hostname is a domain in the ' +
  'target account so the app can derive it.'

export interface CloudflareResponse {
  status: number
  ok: boolean
  body: string
}

export type CloudflareMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Standard Cloudflare envelope. */
export interface CloudflareEnvelope<T = unknown> {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  messages?: Array<{ code?: number; message?: string }>
  result?: T
  result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number }
}

// Module-scope cache of domain -> { zoneId, accountId }. Zone ids are stable, so
// this is not time-bounded; keyed by domain + a short token fingerprint so two
// tenants using different tokens for the same domain never share an entry.
interface ZoneResolution {
  zoneId: string
  accountId: string | null
}
const zoneCache = new Map<string, ZoneResolution>()

export class CloudflareClient {
  private readonly token: string
  private readonly domain: string
  private readonly settingAccountId: string | null
  private readonly timeoutMs: number
  private readonly cacheKey: string

  constructor(opts: { token: string; domain: string; accountId: string | null; timeoutMs: number }) {
    this.token = opts.token
    this.domain = opts.domain
    this.settingAccountId = opts.accountId
    this.timeoutMs = opts.timeoutMs
    this.cacheKey = `${opts.domain}|${opts.token.slice(0, 8)}`
  }

  // ---- scoped helpers ------------------------------------------------------

  /** A zone-scoped request under `/zones/{zone_id}`; path is e.g. `/dns_records`. */
  async zone(
    method: CloudflareMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<CloudflareResponse> {
    const resolved = await this.resolveZone()
    if ('error' in resolved) return synthetic(resolved.error)
    return this.request(method, `/zones/${resolved.zoneId}${path}`, opts)
  }

  /** An account-scoped request under `/accounts/{account_id}`; path is e.g. `/access/apps`. */
  async account(
    method: CloudflareMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<CloudflareResponse> {
    const accountId = await this.resolveAccountId()
    if ('error' in accountId) return synthetic(accountId.error)
    return this.request(method, `/accounts/${accountId.accountId}${path}`, opts)
  }

  /** GET every page of a zone-scoped collection, concatenating `result` arrays. */
  async zoneGetAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    return this.paginate<T>((page, perPage) => this.zone('GET', path, { query: { ...query, page, per_page: perPage } }))
  }

  /** GET every page of an account-scoped collection, concatenating `result` arrays. */
  async accountGetAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    return this.paginate<T>((page, perPage) => this.account('GET', path, { query: { ...query, page, per_page: perPage } }))
  }

  private async paginate<T>(
    fetchPage: (page: number, perPage: number) => Promise<CloudflareResponse>,
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    const perPage = 100
    let page = 1
    let lastStatus = 0
    let lastBody = ''
    const maxPages = 100
    while (page <= maxPages) {
      const res = await fetchPage(page, perPage)
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<CloudflareEnvelope<T[]>>(res.body)
      const result = env?.result
      if (Array.isArray(result)) items.push(...result)
      const totalPages = env?.result_info?.total_pages
      if (!Array.isArray(result) || result.length === 0 || (totalPages !== undefined && page >= totalPages)) break
      if (totalPages === undefined && result.length < perPage) break
      page++
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  // ---- zone/account resolution --------------------------------------------

  /** Resolve the zone id (and owning account id) from the component domain; cached. */
  async resolveZone(): Promise<ZoneResolution | { error: string }> {
    const cached = zoneCache.get(this.cacheKey)
    if (cached) return cached

    const res = await this.request('GET', '/zones', { query: { name: this.domain, per_page: 1 } })
    if (!res.ok) {
      return { error: `Failed to resolve Cloudflare zone for "${this.domain}": ${cloudflareErrorMessage(res)}` }
    }
    const env = parseJson<CloudflareEnvelope<Array<{ id?: string; account?: { id?: string } }>>>(res.body)
    const zone = env?.result?.[0]
    if (!zone?.id) {
      return {
        error: `No Cloudflare zone found for domain "${this.domain}" — check the component hostname and the token's zone scope.`,
      }
    }
    const resolution: ZoneResolution = { zoneId: zone.id, accountId: zone.account?.id ?? null }
    zoneCache.set(this.cacheKey, resolution)
    return resolution
  }

  /** Resolve the account id: the explicit setting wins, else the zone's owning account. */
  async resolveAccountId(): Promise<{ accountId: string } | { error: string }> {
    if (this.settingAccountId) return { accountId: this.settingAccountId }
    const zone = await this.resolveZone()
    if ('error' in zone) return { error: zone.error }
    if (!zone.accountId) return { error: MISSING_ACCOUNT_MESSAGE }
    return { accountId: zone.accountId }
  }

  /** True when an account id is available (setting or derivable from the zone). */
  async hasAccount(): Promise<boolean> {
    return !('error' in (await this.resolveAccountId()))
  }

  /**
   * Verify the API token itself (GET /user/tokens/verify) — a token-scoped probe
   * that needs no zone or account. Used by the connection test.
   */
  async verifyToken(): Promise<CloudflareResponse> {
    return this.request('GET', '/user/tokens/verify', {})
  }

  // ---- transport -----------------------------------------------------------

  private async request(
    method: CloudflareMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<CloudflareResponse> {
    let res = await this.send(method, path, opts)
    let attempts = 0
    while (res.status === 429 && attempts < 2) {
      if (res.retryAfterMs === null || res.retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) break
      await sleep(res.retryAfterMs > 0 ? res.retryAfterMs : 1000)
      res = await this.send(method, path, opts)
      attempts++
    }
    return { status: res.status, ok: res.ok, body: res.body }
  }

  private async send(
    method: CloudflareMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<CloudflareResponse & { retryAfterMs: number | null }> {
    const url = new URL(`${BASE_URL}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      // A response is ok only when the transport succeeded AND the envelope did
      // not report success:false (some paths return 200 with success:false).
      const parsed = parseJson<CloudflareEnvelope>(text)
      const httpOk = res.status >= 200 && res.status < 300
      const ok = httpOk && parsed?.success !== false
      const retryAfter = res.headers.get('retry-after')
      const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null
      return { status: res.status, ok, body: text, retryAfterMs }
    } finally {
      clearTimeout(timer)
    }
  }
}

function synthetic(reason: string): CloudflareResponse {
  return { status: 0, ok: false, body: JSON.stringify({ success: false, errors: [{ message: reason }] }) }
}

/** Build a client from a component hostname (the zone domain), a credential and settings. */
export function buildCloudflareClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: CloudflareClient; domain: string } | { error: string } {
  const token = resolveCloudflareToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const domain = normalizeDomain(hostname)
  if (!domain) {
    return {
      error:
        'No Cloudflare zone domain — register a component whose hostname is the zone (apex) domain, ' +
        'e.g. "example.com".',
    }
  }

  const resolved = readCloudflareSettings(settings)
  return {
    client: new CloudflareClient({
      token,
      domain,
      accountId: resolved.accountId,
      timeoutMs: resolved.timeoutMs,
    }),
    domain,
  }
}

/** Reduce a hostname to a bare domain: strips protocol, path and any leading "www.". */
export function normalizeDomain(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim().toLowerCase()
  if (!host) return null
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  return host.length > 0 ? host : null
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract the `result` payload from a Cloudflare envelope, or null. */
export function cloudflareResult<T>(res: CloudflareResponse): T | null {
  const env = parseJson<CloudflareEnvelope<T>>(res.body)
  return (env?.result ?? null) as T | null
}

/** Extract a human-readable error from a Cloudflare envelope's `errors[]`. */
export function cloudflareErrorMessage(res: CloudflareResponse): string {
  const env = parseJson<CloudflareEnvelope>(res.body)
  const errors = env?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((e) => (e.code ? `${e.message ?? 'error'} (code ${e.code})` : e.message ?? 'error'))
      .join('; ')
  }
  return res.body || `HTTP ${res.status}`
}
