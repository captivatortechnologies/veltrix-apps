// =============================================================================
// Shared CrowdStrike Falcon API client for the crowdstrike-edr app.
//
// Falcon exposes one REST surface per cloud region:
//   US-1     https://api.crowdstrike.com          (auto-discovery default)
//   US-2     https://api.us-2.crowdstrike.com
//   EU-1     https://api.eu-1.crowdstrike.com
//   US-GOV-1 https://api.laggar.gcw.crowdstrike.com   (never auto-discovers)
//   US-GOV-2 https://api.us-gov-2.crowdstrike.mil     (never auto-discovers)
//
// Authentication is OAuth2 client-credentials: POST /oauth2/token with a
// form-encoded client_id/client_secret returns a bearer token with a
// ~30-minute lifespan (no refresh token — re-POST to renew). Authenticating
// against the wrong commercial cloud still succeeds and the response's
// X-Cs-Region header names the tenant's real region; this client follows
// that hint once, mirroring the official SDKs. GovCloud tenants must be
// addressed explicitly via the component hostname or the falcon_region
// app setting.
//
// Every JSON endpoint answers with the { meta, resources, errors } envelope.
// meta.trace_id should be surfaced in error messages — CrowdStrike support
// asks for it. Rate limiting is a per-tenant pool (~6,000 requests/minute);
// 429 responses carry X-RateLimit-RetryAfter (epoch seconds).
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const FALCON_REGION_BASE_URLS: Record<string, string> = {
  'us-1': 'https://api.crowdstrike.com',
  'us-2': 'https://api.us-2.crowdstrike.com',
  'eu-1': 'https://api.eu-1.crowdstrike.com',
  'us-gov-1': 'https://api.laggar.gcw.crowdstrike.com',
  'us-gov-2': 'https://api.us-gov-2.crowdstrike.mil',
}

export const DEFAULT_FALCON_BASE_URL = FALCON_REGION_BASE_URLS['us-1']

/** Token renewal headroom: refresh when less than this remains of the ~30 min TTL. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** Upper bound on how long a single 429 retry will wait for the rate-limit window. */
const MAX_RATE_LIMIT_WAIT_MS = 15_000

export interface FalconSettings {
  region: string
  timeoutMs: number
}

/** Prototype-safe region lookup — canvas/settings values are user input. */
function regionBaseUrl(region: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FALCON_REGION_BASE_URLS, region)
    ? FALCON_REGION_BASE_URLS[region]
    : undefined
}

/** Read and normalize the app settings that drive Falcon API access. */
export function readFalconSettings(settings: Record<string, unknown>): FalconSettings {
  const rawRegion = settings.falcon_region
  const region =
    typeof rawRegion === 'string' && regionBaseUrl(rawRegion.trim().toLowerCase()) !== undefined
      ? rawRegion.trim().toLowerCase()
      : 'auto'

  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : 30

  return { region, timeoutMs: timeoutSeconds * 1000 }
}

/**
 * Resolve the Falcon API base URL for a tenant component.
 * The component hostname is the primary channel (ctx.settings is not
 * populated for production deployments) and may be a region alias
 * ("us-2"), an API hostname ("api.eu-1.crowdstrike.com"), or a full URL.
 * Unrecognized hostnames fall back to the falcon_region setting, then to
 * US-1 — which commercial tenants recover from via X-Cs-Region discovery.
 */
export function resolveFalconBaseUrl(hostname: string, settings?: FalconSettings): string {
  let host = hostname.trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '')
  host = host.split('/')[0] ?? host
  host = host.split(':')[0] ?? host

  const aliasUrl = regionBaseUrl(host)
  if (aliasUrl) return aliasUrl

  for (const baseUrl of Object.values(FALCON_REGION_BASE_URLS)) {
    if (baseUrl === `https://${host}`) return baseUrl
  }

  if (settings && settings.region !== 'auto') {
    return regionBaseUrl(settings.region) ?? DEFAULT_FALCON_BASE_URL
  }
  return DEFAULT_FALCON_BASE_URL
}

export interface FalconApiCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the OAuth2 API client from a Veltrix credential.
 * Convention: client ID in "username", client secret in "API token"
 * (preferred) or "password".
 */
export function resolveFalconCredentials(
  credential: CredentialRef | null,
): FalconApiCredentials | null {
  if (!credential) return null
  const clientId = credential.username?.trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Falcon API client available — store the client ID in the credential "username" field ' +
  'and the client secret in the "API token" field (create one under Support and resources > ' +
  'API clients and keys in the Falcon console)'

export interface FalconResponse {
  status: number
  ok: boolean
  body: string
}

export interface FalconErrorEntry {
  code?: number
  message?: string
}

export interface FalconMeta {
  trace_id?: string
  pagination?: { offset?: number; limit?: number; total?: number; after?: string }
}

export interface FalconEnvelope<T = unknown> {
  meta?: FalconMeta
  resources?: T[] | null
  errors?: FalconErrorEntry[] | null
}

export type FalconMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

interface CachedToken {
  accessToken: string
  expiresAt: number
  baseUrl: string
}

// Tokens live ~30 minutes; cache per app client so consecutive pipeline
// handlers (validate → deploy → healthCheck) reuse one token instead of
// re-authenticating. Keyed by client ID + secret (not base URL) so the
// cached entry — which remembers the discovered region — is found again by
// fresh clients that start at the pre-discovery base URL, and so a rotated
// secret never reuses the old secret's token.
const tokenCache = new Map<string, CachedToken>()

export class FalconClient {
  private baseUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: FalconApiCredentials; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.clientId = opts.credentials.clientId
    this.clientSecret = opts.credentials.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.clientId}|${this.clientSecret}`
  }

  /**
   * POST /oauth2/token (form-encoded, success is 201). Follows a mismatched
   * X-Cs-Region header once — commercial tenants authenticated against the
   * wrong cloud get re-homed to their real region.
   */
  private async authenticate(followRegionHint = true): Promise<string> {
    const cached = tokenCache.get(this.cacheKey())
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      this.baseUrl = cached.baseUrl
      return cached.accessToken
    }

    const res = await this.rawFetch(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    })

    if (res.status !== 201 && res.status !== 200) {
      const detail = falconErrorMessage({ status: res.status, ok: false, body: res.body })
      throw new Error(
        `Falcon authentication failed against ${this.baseUrl}: ${detail}. ` +
          'Check the API client ID/secret and that the credential targets the right cloud region.',
      )
    }

    const parsed = parseJson<{ access_token?: string; expires_in?: number }>(res.body)
    if (!parsed?.access_token) {
      throw new Error(`Falcon authentication returned no access token (HTTP ${res.status})`)
    }

    // Follow the region hint once: a commercial tenant authenticated against
    // the wrong cloud reports its home region in X-Cs-Region.
    const regionHint = res.headers.get('x-cs-region')?.trim().toLowerCase()
    if (followRegionHint && regionHint) {
      const hintedBaseUrl = regionBaseUrl(regionHint)
      if (hintedBaseUrl && hintedBaseUrl !== this.baseUrl) {
        this.baseUrl = hintedBaseUrl
        return this.authenticate(false)
      }
    }

    const expiresInSeconds =
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 1799
    tokenCache.set(this.cacheKey(), {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + expiresInSeconds * 1000,
      baseUrl: this.baseUrl,
    })
    return parsed.access_token
  }

  /**
   * Perform a Falcon API request. Never throws on HTTP error statuses —
   * callers inspect `status` so they can distinguish 404 (missing resource)
   * and partial failures. Throws on network errors, timeout, and
   * authentication failure. Retries once on 401 (expired token) and once on
   * 429 when the rate-limit window reopens within a bounded wait.
   */
  async request(
    method: FalconMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<FalconResponse> {
    let token = await this.authenticate()
    let res = await this.send(method, path, token, opts)

    if (res.status === 401) {
      tokenCache.delete(this.cacheKey())
      token = await this.authenticate()
      res = await this.send(method, path, token, opts)
    }

    if (res.status === 429) {
      const waitMs = rateLimitWaitMs(res.retryAfterEpochSeconds)
      if (waitMs !== null && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(waitMs)
        res = await this.send(method, path, token, opts)
      }
    }

    return { status: res.status, ok: res.ok, body: res.body }
  }

  private async send(
    method: FalconMethod,
    path: string,
    token: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<FalconResponse & { retryAfterEpochSeconds?: number }> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const res = await this.rawFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })

    const retryAfter = res.headers.get('x-ratelimit-retryafter')
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      body: res.body,
      retryAfterEpochSeconds: retryAfter ? Number(retryAfter) : undefined,
    }
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; headers: Headers }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const body = await res.text()
      return { status: res.status, body, headers: res.headers }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build a FalconClient from handler context pieces, or return the reason it
 * cannot be built. Deploy-family handlers all start with this.
 */
export function buildFalconClient(
  componentHostname: string,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: FalconClient; baseUrl: string } | { error: string } {
  const credentials = resolveFalconCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }

  const falconSettings = readFalconSettings(settings)
  const baseUrl = resolveFalconBaseUrl(componentHostname, falconSettings)
  return {
    client: new FalconClient({ baseUrl, credentials, timeoutMs: falconSettings.timeoutMs }),
    baseUrl,
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Parse the standard { meta, resources, errors } envelope. */
export function parseEnvelope<T>(body: string): FalconEnvelope<T> | null {
  return parseJson<FalconEnvelope<T>>(body)
}

/**
 * Human-readable message from a Falcon error response. Includes the first
 * envelope error and meta.trace_id (CrowdStrike support asks for it).
 */
export function falconErrorMessage(res: FalconResponse): string {
  const envelope = parseEnvelope(res.body)
  const firstError = envelope?.errors?.find((e) => e?.message)
  const traceId = envelope?.meta?.trace_id

  let message: string
  if (firstError?.message) {
    message = firstError.code
      ? `${firstError.code}: ${firstError.message}`
      : firstError.message
  } else if (res.status === 429) {
    message = 'HTTP 429: Falcon API rate limit exceeded (per-tenant request pool) — retry later'
  } else if (res.status === 403) {
    message = 'HTTP 403: access denied — check the API client scopes in the Falcon console'
  } else {
    message = `Falcon API returned HTTP ${res.status}`
  }

  return traceId ? `${message} (trace_id: ${traceId})` : message
}

/**
 * Reason a write request failed, or null on genuine success. Falcon can
 * return envelope errors[] even on 2xx (partial failures), so callers that
 * mutate state must check this rather than HTTP status alone.
 */
export function falconFailure(res: FalconResponse): string | null {
  if (!res.ok) return falconErrorMessage(res)
  const errors = parseEnvelope(res.body)?.errors
  if (errors && errors.length > 0) return falconErrorMessage(res)
  return null
}

/** Escape a value for use inside single quotes in an FQL filter expression. */
export function fqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Coerce a canvas checkbox value to a boolean. Canvas serializers may store
 * booleans as strings or numbers; anything unrecognized keeps the default.
 */
export function coerceBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return defaultValue
}

/** Order-insensitive equality of two string lists. */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

/** Wait duration until the X-RateLimit-RetryAfter epoch, or null if unusable. */
function rateLimitWaitMs(retryAfterEpochSeconds: number | undefined): number | null {
  if (retryAfterEpochSeconds === undefined || !Number.isFinite(retryAfterEpochSeconds)) return null
  const waitMs = retryAfterEpochSeconds * 1000 - Date.now()
  return waitMs > 0 ? waitMs : 0
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Split a comma/newline separated canvas value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}
