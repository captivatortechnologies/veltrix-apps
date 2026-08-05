// =============================================================================
// PingOne Management (Platform) API client for the ping-identity app.
//
// Auth: a PingOne "Worker" application (OAuth2 client_credentials grant).
//   Token:  POST https://auth.pingone.<region>/{environmentId}/as/token
//           body: grant_type=client_credentials (form-encoded)
//           auth: HTTP Basic (clientId:clientSecret)
//   API:    https://api.pingone.<region>/v1/environments/{environmentId}/...
//           header: Authorization: Bearer <access_token>
// Verified directly against Ping's own generated SDK source (the same OpenAPI
// spec that backs https://apidocs.pingidentity.com/pingone/platform/v1/api/):
//   - Region -> hostname-suffix mapping: pingone-go-sdk-v2/pingone/model/region.go
//   - Token endpoint construction:       pingone-go-sdk-v2/pingone/client.go (getToken)
//   - Resource base path (/v1/environments/{id}/...): every *Api.md doc under
//     pingone-go-sdk-v2/management/docs, e.g. SignOnPoliciesApi.md
//
// Access tokens are short-lived (PingOne's default is 3600s); this client
// caches one per worker credential and refreshes with headroom. Handlers run
// in-process in the platform's Node runtime, so this uses fetch with an
// AbortController timeout and no external HTTP dependency. request() never
// throws on an HTTP error status - callers inspect `status` so they can tell a
// 404 (object absent) from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** Refresh the cached token when less than this remains of its lifetime. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** PingOne access tokens default to 3600s; used when the response omits expires_in. */
const DEFAULT_TOKEN_TTL_SECONDS = 3600

// --- Regions ------------------------------------------------------------------

/**
 * PingOne data-residency regions -> hostname suffix, straight from
 * pingone-go-sdk-v2/pingone/model/region.go (regionMappingList). A tenant's
 * region is fixed at environment-creation time and is NOT discoverable from
 * the environment id alone - the admin must select it.
 */
export const PINGONE_REGIONS = {
  NA: { suffix: 'com', label: 'North America (pingone.com)' },
  EU: { suffix: 'eu', label: 'European Union (pingone.eu)' },
  CA: { suffix: 'ca', label: 'Canada (pingone.ca)' },
  AP: { suffix: 'asia', label: 'Asia-Pacific (pingone.asia)' },
  AU: { suffix: 'com.au', label: 'Australia (pingone.com.au)' },
  SG: { suffix: 'sg', label: 'Singapore (pingone.sg)' },
} as const

export type PingOneRegion = keyof typeof PINGONE_REGIONS

export const DEFAULT_PINGONE_REGION: PingOneRegion = 'NA'

/** Prototype-safe region lookup - canvas/settings values are user input. */
function regionSuffix(region: string): string | undefined {
  const key = region.toUpperCase()
  return Object.prototype.hasOwnProperty.call(PINGONE_REGIONS, key)
    ? PINGONE_REGIONS[key as PingOneRegion].suffix
    : undefined
}

export function isValidPingOneRegion(region: string): region is PingOneRegion {
  return Object.prototype.hasOwnProperty.call(PINGONE_REGIONS, region?.toUpperCase?.() ?? '')
}

export interface PingOneSettings {
  region: PingOneRegion
  timeoutMs: number
}

/** Read and normalize the app settings that drive PingOne API access. */
export function readPingOneSettings(settings: Record<string, unknown>): PingOneSettings {
  const rawRegion = settings.pingone_region
  const region: PingOneRegion =
    typeof rawRegion === 'string' && isValidPingOneRegion(rawRegion)
      ? (rawRegion.toUpperCase() as PingOneRegion)
      : DEFAULT_PINGONE_REGION

  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30

  return { region, timeoutMs: timeoutSeconds * 1000 }
}

// --- Credentials ---------------------------------------------------------------

export interface PingOneWorkerCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the PingOne worker-app OAuth2 client from a Veltrix credential.
 * Convention (mirrors crowdstrike-edr / okta-identity): client ID in
 * "username", client secret in "API token" (preferred) or "password".
 */
export function resolvePingOneCredentials(
  credential: CredentialRef | null,
): PingOneWorkerCredentials | null {
  if (!credential) return null
  const clientId = credential.username?.trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No PingOne worker application credentials available - store the worker application\'s Client ID ' +
  'in the credential "username" field and its Client Secret in the "API token" field. Create a ' +
  'worker application under Applications > Applications > + Add Application > Worker in the PingOne ' +
  'admin console, and grant it the roles this app needs (e.g. Environment Admin or a scoped custom role).'

/**
 * Extract the PingOne Environment ID from a connection. Convention (mirrors
 * okta-identity's org-domain-as-hostname): the environment id is stored as the
 * deploy-target component's hostname (surfaced in ConnectionsManager as the
 * "endpoint" field).
 */
export function resolveEnvironmentId(hostname: string | null | undefined): string | null {
  const trimmed = hostname?.trim()
  return trimmed ? trimmed : null
}

export const MISSING_ENVIRONMENT_MESSAGE =
  'No PingOne environment is registered for this connection yet - set the Environment ID (from ' +
  'Environments > <your environment> > Properties in the PingOne admin console) as the connection\'s ' +
  'endpoint, and save the connection.'

// --- HTTP client ----------------------------------------------------------------

export interface PingOneResponse {
  status: number
  ok: boolean
  body: string
}

export interface PingOneErrorEntry {
  code?: string
  message?: string
  target?: string
}

/** PingOne's standard error envelope: { id, code, message, details: [...] }. */
export interface PingOneErrorEnvelope {
  id?: string
  code?: string
  message?: string
  details?: PingOneErrorEntry[]
}

export type PingOneMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Tokens live ~1 hour; cache per (region, environment, clientId+secret) so
// consecutive pipeline handlers (validate -> deploy -> healthCheck) reuse one
// token instead of re-authenticating on every call.
const tokenCache = new Map<string, CachedToken>()

export class PingOneClient {
  private readonly apiBaseUrl: string
  private readonly authBaseUrl: string
  private readonly environmentId: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number

  constructor(opts: {
    region: PingOneRegion
    environmentId: string
    credentials: PingOneWorkerCredentials
    timeoutMs: number
  }) {
    const suffix = PINGONE_REGIONS[opts.region].suffix
    this.apiBaseUrl = `https://api.pingone.${suffix}/v1`
    this.authBaseUrl = `https://auth.pingone.${suffix}`
    this.environmentId = opts.environmentId
    this.clientId = opts.credentials.clientId
    this.clientSecret = opts.credentials.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.authBaseUrl}|${this.environmentId}|${this.clientId}|${this.clientSecret}`
  }

  /** POST {authBaseUrl}/{environmentId}/as/token - HTTP Basic client_credentials grant. */
  private async authenticate(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey())
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')
    const res = await this.rawFetch(`${this.authBaseUrl}/${this.environmentId}/as/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    })

    if (!res.ok) {
      throw new Error(
        `PingOne worker authentication failed against ${this.authBaseUrl}: ${pingOneErrorMessage(res)}. ` +
          'Check the worker Client ID/Secret, the environment id, and that the region matches the ' +
          "environment's data-residency region.",
      )
    }

    const parsed = parseJson<{ access_token?: string; expires_in?: number }>(res.body)
    if (!parsed?.access_token) {
      throw new Error(`PingOne authentication returned no access_token (HTTP ${res.status})`)
    }

    const ttlSeconds =
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0
        ? parsed.expires_in
        : DEFAULT_TOKEN_TTL_SECONDS
    tokenCache.set(this.cacheKey(), {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
    return parsed.access_token
  }

  /**
   * Perform a request against /v1/environments/{environmentId}{path}. Never
   * throws on an HTTP error status - callers inspect `status`. Retries once on
   * 401 (expired/revoked token). Throws on network errors, timeout, and
   * authentication failure.
   */
  async request(
    method: PingOneMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<PingOneResponse> {
    let token = await this.authenticate()
    let res = await this.send(method, path, token, opts)

    if (res.status === 401) {
      tokenCache.delete(this.cacheKey())
      token = await this.authenticate()
      res = await this.send(method, path, token, opts)
    }

    return res
  }

  /**
   * GET a collection endpoint and return its `_embedded[wrapperKey]` array -
   * every PingOne list response is a HAL document shaped
   * `{ _embedded: { <wrapperKey>: [...] }, count, size, _links }`. Follows
   * `_links.next.href` to walk every page.
   */
  async getAll<T = unknown>(
    path: string,
    wrapperKey: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let nextUrl: string | null = null
    let firstPage = true
    let lastStatus = 0
    let lastBody = ''

    while (firstPage || nextUrl) {
      const res: PingOneResponse = nextUrl
        ? await this.sendAbsolute('GET', nextUrl)
        : await this.request('GET', path, { query })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }

      const parsed = parseJson<{
        _embedded?: Record<string, T[]>
        _links?: { next?: { href?: string } }
      }>(res.body)
      const page = parsed?._embedded?.[wrapperKey]
      if (Array.isArray(page)) items.push(...page)
      nextUrl = parsed?._links?.next?.href ?? null
      firstPage = false
    }

    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async send(
    method: PingOneMethod,
    path: string,
    token: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<PingOneResponse> {
    const url = new URL(`${this.apiBaseUrl}/environments/${this.environmentId}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.fetchUrl(method, url.toString(), token, opts.body)
  }

  private async sendAbsolute(method: PingOneMethod, absoluteUrl: string): Promise<PingOneResponse> {
    const token = await this.authenticate()
    return this.fetchUrl(method, absoluteUrl, token, undefined)
  }

  private async fetchUrl(
    method: PingOneMethod,
    url: string,
    token: string,
    body: unknown,
  ): Promise<PingOneResponse> {
    const res = await this.rawFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return res
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<PingOneResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build a PingOne client from a component hostname (holding the Environment
 * ID), a credential (worker client id/secret) and app settings (region,
 * timeout). Returns a descriptive `error` instead of throwing so every
 * handler can surface one consistent message.
 */
export function buildPingOneClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: PingOneClient; environmentId: string; region: PingOneRegion } | { error: string } {
  const credentials = resolvePingOneCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }

  const environmentId = resolveEnvironmentId(hostname)
  if (!environmentId) return { error: MISSING_ENVIRONMENT_MESSAGE }

  const resolved = readPingOneSettings(settings)
  return {
    client: new PingOneClient({
      region: resolved.region,
      environmentId,
      credentials,
      timeoutMs: resolved.timeoutMs,
    }),
    environmentId,
    region: resolved.region,
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from a PingOne error response body. */
export function pingOneErrorMessage(res: PingOneResponse): string {
  const parsed = parseJson<PingOneErrorEnvelope>(res.body)
  if (parsed?.message) {
    const details = (parsed.details ?? [])
      .map((d) => d.message)
      .filter(Boolean)
      .join('; ')
    return details ? `${parsed.message} (${details})` : parsed.message
  }
  return res.body || `HTTP ${res.status}`
}

/** Deterministic JSON stringify with recursively sorted object keys - for drift comparisons. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
