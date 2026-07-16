// =============================================================================
// Microsoft Defender for Endpoint (MDE) API client.
//
// Auth is Azure AD OAuth2 client-credentials. The app registration's client id +
// secret (from a Veltrix credential) are exchanged for a bearer token at
// https://<loginHost>/{tenantId}/oauth2/v2.0/token. Tokens live ~1h and are
// cached per audience.
//
// IMPORTANT (verified): the token audience must be the LEGACY resource
// `https://api.securitycenter.microsoft.com/.default` even though requests go to
// the newer host `https://api.security.microsoft.com/api/...`. A token minted for
// the new host is rejected with 403. So `apiResource` (token audience) and
// `apiHost` (request host) are intentionally different.
//
// Custom detection rules live on Microsoft Graph (beta) under a SEPARATE audience
// (`https://graph.microsoft.com/.default`) and only in the commercial cloud.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout,
// never throws on an HTTP error status, and honors 429 Retry-After.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const MAX_RATE_LIMIT_WAIT_MS = 30_000
const TOKEN_EXPIRY_BUFFER_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type AzureCloud = 'commercial' | 'gcc' | 'gcc-high' | 'dod'

/** Per-cloud hosts. `graphHost` is null where Graph detection rules are unavailable. */
export interface CloudProfile {
  loginHost: string
  /** OAuth2 token audience for the MDE API (NOT the request host). */
  apiResource: string
  /** Default request host when the component hostname is not set. */
  defaultApiHost: string
  graphHost: string | null
  graphResource: string | null
}

export function cloudProfile(cloud: AzureCloud): CloudProfile {
  switch (cloud) {
    case 'gcc':
      return {
        loginHost: 'login.microsoftonline.com',
        apiResource: 'https://api-gcc.securitycenter.microsoft.us',
        defaultApiHost: 'api-gcc.securitycenter.microsoft.us',
        graphHost: null,
        graphResource: null,
      }
    case 'gcc-high':
    case 'dod':
      return {
        loginHost: 'login.microsoftonline.us',
        apiResource: 'https://api-gov.securitycenter.microsoft.us',
        defaultApiHost: 'api-gov.securitycenter.microsoft.us',
        graphHost: null,
        graphResource: null,
      }
    case 'commercial':
    default:
      return {
        loginHost: 'login.microsoftonline.com',
        apiResource: 'https://api.securitycenter.microsoft.com',
        defaultApiHost: 'api.security.microsoft.com',
        graphHost: 'graph.microsoft.com',
        graphResource: 'https://graph.microsoft.com',
      }
  }
}

export interface MdeSettings {
  tenantId: string | null
  cloud: AzureCloud
  timeoutMs: number
}

export function readMdeSettings(settings: Record<string, unknown>): MdeSettings {
  const rawTenant = settings.tenant_id
  const tenantId = typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : null

  const rawCloud = typeof settings.azure_cloud === 'string' ? settings.azure_cloud.trim().toLowerCase() : ''
  const cloud: AzureCloud =
    rawCloud === 'gcc' || rawCloud === 'gcc-high' || rawCloud === 'dod' ? (rawCloud as AzureCloud) : 'commercial'

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout * 1000 : REQUEST_TIMEOUT_MS

  return { tenantId, cloud, timeoutMs }
}

export interface MdeCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the app-registration client id + secret from a Veltrix credential:
 * Client ID in `username`, Client Secret in `apiToken` (or `password`).
 */
export function resolveMdeCredentials(credential: CredentialRef | null): MdeCredentials | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Microsoft Entra app credential — store the app registration Client ID in the credential "username" ' +
  'field and its Client Secret in the "API token" field. The app needs the WindowsDefenderATP application ' +
  'permission Ti.ReadWrite.All (and, for detection rules, the Graph CustomDetection.ReadWrite.All).'

export const MISSING_TENANT_MESSAGE =
  'No Microsoft Entra tenant id — set the "Tenant ID" app setting (the directory/tenant GUID). It is ' +
  'required to acquire an access token.'

export interface MdeResponse {
  status: number
  ok: boolean
  body: string
}

export type MdeMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** OData collection envelope (MDE API and Graph). */
export interface ODataEnvelope<T = unknown> {
  value?: T[]
  '@odata.nextLink'?: string
  '@odata.count'?: number
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

export class MdeClient {
  private readonly apiBase: string
  private readonly tokenUrl: string
  private readonly apiResource: string
  private readonly graphHost: string | null
  private readonly graphResource: string | null
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number
  private readonly tokenCache = new Map<string, CachedToken>()

  constructor(opts: {
    apiHost: string
    profile: CloudProfile
    tenantId: string
    creds: MdeCredentials
    timeoutMs: number
  }) {
    this.apiBase = `https://${opts.apiHost}/api`
    this.tokenUrl = `https://${opts.profile.loginHost}/${opts.tenantId}/oauth2/v2.0/token`
    this.apiResource = opts.profile.apiResource
    this.graphHost = opts.profile.graphHost
    this.graphResource = opts.profile.graphResource
    this.clientId = opts.creds.clientId
    this.clientSecret = opts.creds.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  /** True when Graph (custom detection rules) is available for this cloud. */
  get graphAvailable(): boolean {
    return this.graphHost !== null && this.graphResource !== null
  }

  /** An MDE API request (host api.security.microsoft.com; token audience api.securitycenter…). */
  async request(
    method: MdeMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<MdeResponse> {
    return this.send(this.apiResource, `${this.apiBase}${path}`, method, opts)
  }

  /** A Microsoft Graph (beta) request — used for custom detection rules. */
  async graph(
    method: MdeMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<MdeResponse> {
    if (!this.graphHost || !this.graphResource) {
      return synthetic('Microsoft Graph (custom detection rules) is only available in the commercial cloud.')
    }
    return this.send(this.graphResource, `https://${this.graphHost}/beta${path}`, method, opts)
  }

  /** GET every page of an MDE OData collection, following `@odata.nextLink`. */
  async getAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let res = await this.request('GET', path, { query })
    let lastStatus = res.status
    let lastBody = res.body
    const maxPages = 50
    for (let page = 0; page < maxPages; page++) {
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<ODataEnvelope<T>>(res.body)
      if (Array.isArray(env?.value)) items.push(...env!.value!)
      const next = env?.['@odata.nextLink']
      if (!next) break
      res = await this.send(this.apiResource, next, 'GET', {})
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  // ---- token + transport ----------------------------------------------------

  /** Acquire (and cache) a bearer token for an audience. NON-UNION result. */
  private async acquireToken(resource: string): Promise<{ token: string | null; error: string | null }> {
    const cached = this.tokenCache.get(resource)
    if (cached && cached.expiresAtMs > Date.now()) return { token: cached.token, error: null }

    const bodyParams = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: `${resource}/.default`,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: bodyParams.toString(),
        signal: controller.signal,
      })
      const text = await res.text()
      const parsed = parseJson<{ access_token?: string; expires_in?: number; error_description?: string; error?: string }>(text)
      if (!res.ok || !parsed?.access_token) {
        const reason = parsed?.error_description || parsed?.error || `HTTP ${res.status}`
        return { token: null, error: `token request failed: ${reason}` }
      }
      const ttlMs = (typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600) * 1000
      this.tokenCache.set(resource, { token: parsed.access_token, expiresAtMs: Date.now() + ttlMs - TOKEN_EXPIRY_BUFFER_MS })
      return { token: parsed.access_token, error: null }
    } catch (err) {
      return { token: null, error: err instanceof Error ? err.message : 'token request failed' }
    } finally {
      clearTimeout(timer)
    }
  }

  private async send(
    resource: string,
    url: string,
    method: MdeMethod,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<MdeResponse> {
    const auth = await this.acquireToken(resource)
    if (!auth.token) return synthetic(auth.error ?? 'authentication failed')

    const target = new URL(url)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) target.searchParams.set(key, String(value))
    }

    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(target.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${auth.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        })
        const text = await res.text()
        if (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
          const retryAfter = Number(res.headers.get('retry-after'))
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000
          if (waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
            attempts++
            clearTimeout(timer)
            await sleep(waitMs)
            continue
          }
        }
        return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

function synthetic(reason: string): MdeResponse {
  return { status: 0, ok: false, body: JSON.stringify({ error: { message: reason } }) }
}

/** Reduce a hostname to a bare API host: strips protocol, path and port. */
export function normalizeApiHost(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim().toLowerCase()
  if (!host) return null
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  return host.length > 0 ? host : null
}

/** Build a client from a component hostname (the API host), a credential and settings. */
export function buildMdeClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: MdeClient; apiHost: string; cloud: AzureCloud } | { error: string } {
  const creds = resolveMdeCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readMdeSettings(settings)
  if (!resolved.tenantId) return { error: MISSING_TENANT_MESSAGE }

  const profile = cloudProfile(resolved.cloud)
  const apiHost = normalizeApiHost(hostname) ?? profile.defaultApiHost

  return {
    client: new MdeClient({ apiHost, profile, tenantId: resolved.tenantId, creds, timeoutMs: resolved.timeoutMs }),
    apiHost,
    cloud: resolved.cloud,
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

/** Extract a human-readable error from an MDE / Graph error response. */
export function mdeErrorMessage(res: MdeResponse): string {
  const parsed = parseJson<{ error?: { message?: string; code?: string } | string }>(res.body)
  if (parsed?.error && typeof parsed.error === 'object') {
    return parsed.error.message || parsed.error.code || `HTTP ${res.status}`
  }
  if (typeof parsed?.error === 'string') return parsed.error
  return res.body || `HTTP ${res.status}`
}
