// =============================================================================
// Sophos Central API client — auth, tenant/region discovery, requests.
//
// Sophos Central's public API program (https://developer.sophos.com) is split
// into a GLOBAL identity/discovery surface and per-tenant REGIONAL product
// APIs. Authentication is OAuth2 client-credentials against a single global
// identity host — there is no per-region auth endpoint and no "wrong cloud"
// concept the way CrowdStrike Falcon has:
//
//   POST https://id.sophos.com/api/v2/oauth2/token
//     Content-Type: application/x-www-form-urlencoded
//     grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scope=token
//
//   -> { "access_token": "<jwt>", "token_type": "bearer", "expires_in": 3600, ... }
//
// The returned JWT is a bearer token good for every Sophos Central API. To
// know WHERE a tenant's data lives, call the global Who-Am-I API with that
// token:
//
//   GET https://api.central.sophos.com/whoami/v1
//     Authorization: Bearer <jwt>
//
//   -> { "id": "<uuid>", "idType": "tenant" | "organization" | "partner",
//        "apiHosts": { "global": "https://api.central.sophos.com",
//                       "dataRegion": "https://api-us02.central.sophos.com" } }
//
// This app is built for TENANT-level service principals (Sophos Central Admin
// > Global Settings > API Credentials — see the "Getting Started as a Tenant"
// guide at https://developer.sophos.com/getting-started-tenant), so `idType`
// must be "tenant". Every subsequent regional (per-product) API call is made
// against `apiHosts.dataRegion` and must carry both the bearer token and the
// tenant id:
//
//   GET https://api-us02.central.sophos.com/endpoint/v1/policies
//     Authorization: Bearer <jwt>
//     X-Tenant-ID: <tenant-id>
//
// Docs referenced throughout this client and the config types that use it:
//   https://developer.sophos.com/intro (auth, multi-tenancy header, pagination, rate limits, errors)
//   https://developer.sophos.com/docs/whoami-v1/1/overview
//   https://developer.sophos.com/docs/endpoint-v1/1/overview
//   https://developer.sophos.com/docs/common-v1/1/overview
// =============================================================================

import type { CredentialRef, HealthCheck } from '@veltrixsecops/app-sdk'

export const TOKEN_URL = 'https://id.sophos.com/api/v2/oauth2/token'
export const WHOAMI_URL = 'https://api.central.sophos.com/whoami/v1'

const DEFAULT_TIMEOUT_MS = 30_000
/** Renew the cached token when less than this remains of its ~1 hour TTL. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** Retrying-on-error backoff, per https://developer.sophos.com/intro#retrying-on-error. */
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000
const MAX_TRANSIENT_RETRIES = 2

export interface SophosSettings {
  timeoutMs: number
}

/** Read the app settings that drive Sophos Central API access. */
export function readSophosSettings(settings: Record<string, unknown>): SophosSettings {
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS
  return { timeoutMs }
}

export interface SophosApiCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the OAuth2 service-principal client from a Veltrix credential.
 * Convention (mirrors the other OAuth2-client-credentials apps in this repo):
 * client ID in "username", client secret in "API token" (preferred) or
 * "password".
 */
export function resolveSophosCredentials(credential: CredentialRef | null): SophosApiCredentials | null {
  if (!credential) return null
  const clientId = credential.username?.trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Sophos Central API service principal available — create one as a TENANT admin in Sophos ' +
  'Central Admin (Global Settings > API Credentials), store the Client ID in the credential\'s ' +
  '"username" field and the Client Secret in its "API token" field. See ' +
  'https://developer.sophos.com/getting-started-tenant for the exact steps.'

export const WRONG_PRINCIPAL_LEVEL_MESSAGE =
  'This service principal is not a TENANT-level principal. Sophos Central\'s Who-Am-I API ' +
  'reported idType "%s", but this app manages one tenant\'s endpoint configuration and requires ' +
  'a service principal created under a tenant\'s own Sophos Central Admin (Global Settings > ' +
  'API Credentials) — not a partner or organization (Enterprise) principal.'

export interface SophosResponse {
  status: number
  ok: boolean
  body: string
}

export type SophosMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

interface CachedAuth {
  accessToken: string
  expiresAt: number
  tenantId: string
  dataRegionBaseUrl: string
}

// Cache the resolved { token, tenantId, dataRegion } per service-principal
// credential pair so consecutive pipeline handlers (validate -> deploy ->
// healthCheck) reuse one token/whoami round trip instead of repeating both on
// every call. Keyed by client id + secret (not any component identifier) so a
// rotated secret never reuses a stale tenant/region resolution.
const authCache = new Map<string, CachedAuth>()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Full jitter backoff per https://developer.sophos.com/intro#retrying-on-error. */
function backoffMs(attempt: number): number {
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(Math.random() * cap)
}

export class SophosClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number

  constructor(opts: { credentials: SophosApiCredentials; timeoutMs: number }) {
    this.clientId = opts.credentials.clientId
    this.clientSecret = opts.credentials.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.clientId}|${this.clientSecret}`
  }

  /**
   * Resolve { accessToken, tenantId, dataRegionBaseUrl }, authenticating and
   * calling Who-Am-I only when the cached token is missing or near expiry.
   */
  private async authenticate(): Promise<CachedAuth> {
    const cached = authCache.get(this.cacheKey())
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached
    }

    const tokenRes = await this.rawFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'token',
      }).toString(),
    })

    if (tokenRes.status !== 200) {
      throw new Error(
        `Sophos ID authentication failed (HTTP ${tokenRes.status}): ${sophosErrorMessage({
          status: tokenRes.status,
          ok: false,
          body: tokenRes.body,
        })}. Check the service principal's Client ID and Client Secret.`,
      )
    }

    const tokenBody = parseJson<{ access_token?: string; expires_in?: number; token_type?: string }>(tokenRes.body)
    if (!tokenBody?.access_token) {
      throw new Error(`Sophos ID authentication returned no access token (HTTP ${tokenRes.status})`)
    }

    const whoamiRes = await this.rawFetch(WHOAMI_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: 'application/json' },
    })
    if (whoamiRes.status !== 200) {
      throw new Error(
        `Sophos Central Who-Am-I lookup failed (HTTP ${whoamiRes.status}): ${sophosErrorMessage({
          status: whoamiRes.status,
          ok: false,
          body: whoamiRes.body,
        })}`,
      )
    }
    const whoami = parseJson<{ id?: string; idType?: string; apiHosts?: { global?: string; dataRegion?: string } }>(
      whoamiRes.body,
    )
    if (!whoami?.id || !whoami.idType) {
      throw new Error('Sophos Central Who-Am-I lookup returned an unexpected response (missing id/idType)')
    }
    if (whoami.idType !== 'tenant') {
      throw new Error(WRONG_PRINCIPAL_LEVEL_MESSAGE.replace('%s', whoami.idType))
    }
    if (!whoami.apiHosts?.dataRegion) {
      throw new Error('Sophos Central Who-Am-I lookup did not return a dataRegion API host for this tenant')
    }

    const expiresInSeconds =
      typeof tokenBody.expires_in === 'number' && tokenBody.expires_in > 0 ? tokenBody.expires_in : 3600
    const resolved: CachedAuth = {
      accessToken: tokenBody.access_token,
      expiresAt: Date.now() + expiresInSeconds * 1000,
      tenantId: whoami.id,
      dataRegionBaseUrl: whoami.apiHosts.dataRegion.replace(/\/+$/, ''),
    }
    authCache.set(this.cacheKey(), resolved)
    return resolved
  }

  /** The resolved tenant UUID (X-Tenant-ID) — authenticates first if needed. */
  async tenantId(): Promise<string> {
    return (await this.authenticate()).tenantId
  }

  /**
   * Perform a request against one of the tenant's regional product APIs.
   * `service` is the API family root, e.g. "endpoint/v1" or "common/v1";
   * `path` is relative to it, e.g. "/policies" or "/settings/allowed-items".
   * Never throws on an HTTP error status — callers inspect `status`/`ok` so
   * they can tell a 404 (missing resource) from a genuine failure. Retries
   * once on 401 (stale cached token) and up to MAX_TRANSIENT_RETRIES times on
   * 429/5xx with full-jitter backoff, per Sophos's own retry guidance.
   */
  async request(
    service: string,
    method: SophosMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | (string | number)[] | undefined>; body?: unknown } = {},
  ): Promise<SophosResponse> {
    let auth = await this.authenticate()
    let res = await this.send(service, method, path, auth, opts)

    if (res.status === 401) {
      authCache.delete(this.cacheKey())
      auth = await this.authenticate()
      res = await this.send(service, method, path, auth, opts)
    }

    let attempt = 0
    while ((res.status === 429 || res.status >= 500) && attempt < MAX_TRANSIENT_RETRIES) {
      await sleep(backoffMs(attempt))
      attempt++
      res = await this.send(service, method, path, auth, opts)
    }

    return { status: res.status, ok: res.ok, body: res.body }
  }

  private async send(
    service: string,
    method: SophosMethod,
    path: string,
    auth: CachedAuth,
    opts: { query?: Record<string, string | number | boolean | (string | number)[] | undefined>; body?: unknown },
  ): Promise<SophosResponse> {
    const url = new URL(`${auth.dataRegionBaseUrl}/${service}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v))
      } else {
        url.searchParams.set(key, String(value))
      }
    }

    const res = await this.rawFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'X-Tenant-ID': auth.tenantId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: res.body }
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const body = await res.text()
      return { status: res.status, body }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from handler context pieces, or return the reason it cannot be built. */
export function buildSophosClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: SophosClient } | { error: string } {
  const credentials = resolveSophosCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }
  const resolved = readSophosSettings(settings)
  return { client: new SophosClient({ credentials, timeoutMs: resolved.timeoutMs }) }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/**
 * Sophos error responses are a flat object per
 * https://developer.sophos.com/intro#error-response-object:
 *   { error, message, correlationId, code, createdAt, requestId, docUrl }
 * Surfaces the correlationId (Sophos Support asks for it) when present.
 */
export function sophosErrorMessage(res: SophosResponse): string {
  const parsed = parseJson<{ error?: string; message?: string; correlationId?: string }>(res.body)
  if (parsed?.message) {
    return parsed.correlationId ? `${parsed.message} (correlationId: ${parsed.correlationId})` : parsed.message
  }
  if (parsed?.error) {
    return parsed.correlationId ? `${parsed.error} (correlationId: ${parsed.correlationId})` : parsed.error
  }
  const trimmed = (res.body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return `HTTP ${res.status}`
  return trimmed.length > 300 ? `HTTP ${res.status}: ${trimmed.slice(0, 297)}...` : `HTTP ${res.status}: ${trimmed}`
}

/** A page envelope as documented at https://developer.sophos.com/intro#pagination. */
export interface SophosPage<T> {
  pages?: { current?: number; size?: number; total?: number; maxSize?: number; fromKey?: string; nextKey?: string }
  items?: T[]
  errors?: unknown
}

const MAX_PAGES = 50

/**
 * Fetch every page of a page-by-offset list endpoint (page/pageSize/pageTotal
 * query params), stopping when a page returns fewer than `pageSize` items or
 * after MAX_PAGES as a runaway-loop safety cap. Throws on the first failed
 * page.
 */
export async function listAllPages<T>(
  client: SophosClient,
  service: string,
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; pageSize?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100
  const items: T[] = []
  let page = 1
  while (page <= MAX_PAGES) {
    const res = await client.request(service, 'GET', path, {
      query: { ...opts.query, page, pageSize },
    })
    if (!res.ok) throw new Error(`Failed to list "${service}${path}": ${sophosErrorMessage(res)}`)
    const parsed = parseJson<SophosPage<T>>(res.body)
    const pageItems = Array.isArray(parsed?.items) ? parsed!.items! : []
    items.push(...pageItems)
    if (pageItems.length < pageSize) break
    page++
  }
  return items
}

/**
 * Fetch every page of a page-by-key list endpoint (pageFromKey/pageSize/
 * pageTotal query params — used by e.g. GET .../endpoint-groups/{id}/endpoints),
 * following `pages.nextKey` until absent, or after MAX_PAGES as a
 * runaway-loop safety cap. Throws on the first failed page.
 */
export async function listAllPagesByKey<T>(
  client: SophosClient,
  service: string,
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; pageSize?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 500
  const items: T[] = []
  let fromKey: string | undefined
  let page = 1
  while (page <= MAX_PAGES) {
    const res = await client.request(service, 'GET', path, {
      query: { ...opts.query, pageFromKey: fromKey, pageSize },
    })
    if (!res.ok) throw new Error(`Failed to list "${service}${path}": ${sophosErrorMessage(res)}`)
    const parsed = parseJson<SophosPage<T>>(res.body)
    items.push(...(Array.isArray(parsed?.items) ? parsed!.items! : []))
    const nextKey = parsed?.pages?.nextKey
    if (!nextKey) break
    fromKey = nextKey
    page++
  }
  return items
}

/** Split an array into chunks of at most `size` items each. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The reachability check every config type's healthCheck opens with: Sophos
 * ID accepts the service principal and Who-Am-I resolves a tenant. Also
 * confirms the resolved data-region base URL for the message.
 */
export async function checkSophosReachable(client: SophosClient): Promise<HealthCheck> {
  const started = Date.now()
  try {
    await client.tenantId()
    return {
      name: 'sophos_reachable',
      passed: true,
      message: 'Sophos Central API reachable and service principal accepted.',
      latencyMs: Date.now() - started,
    }
  } catch (error) {
    return {
      name: 'sophos_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Sophos Central API unreachable',
      latencyMs: Date.now() - started,
    }
  }
}
