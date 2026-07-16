// =============================================================================
// Microsoft Intune (Graph) client.
//
// Intune endpoint-security policies are exposed on Microsoft Graph under
// /deviceManagement/. Auth is Azure AD OAuth2 client-credentials: an app
// registration's client id + secret (from a Veltrix credential) are exchanged
// for a bearer token at https://<loginHost>/{tenantId}/oauth2/v2.0/token with
// scope https://<graphHost>/.default. Tokens live ~1h and are cached.
//
// The endpoint-security / settings-catalog surface (configurationPolicies) is
// BETA — requests target https://<graphHost>/beta. It needs the Graph
// application permission DeviceManagementConfiguration.ReadWrite.All (or
// DeviceManagementEndpointSecurity.ReadWrite.All) and an Intune license.
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

export interface CloudProfile {
  loginHost: string
  graphHost: string
}

/** Per-cloud login + Graph hosts. GCC (moderate) uses commercial Graph; GCC High / DoD use the .us Graph. */
export function cloudProfile(cloud: AzureCloud): CloudProfile {
  switch (cloud) {
    case 'gcc-high':
    case 'dod':
      return { loginHost: 'login.microsoftonline.us', graphHost: 'graph.microsoft.us' }
    case 'gcc':
    case 'commercial':
    default:
      return { loginHost: 'login.microsoftonline.com', graphHost: 'graph.microsoft.com' }
  }
}

export interface IntuneSettings {
  tenantId: string | null
  cloud: AzureCloud
  timeoutMs: number
}

export function readIntuneSettings(settings: Record<string, unknown>): IntuneSettings {
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

export interface IntuneCredentials {
  clientId: string
  clientSecret: string
}

/** Extract the app-registration client id + secret: Client ID in `username`, secret in `apiToken`/`password`. */
export function resolveIntuneCredentials(credential: CredentialRef | null): IntuneCredentials | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Microsoft Entra app credential — store the app registration Client ID in the credential "username" ' +
  'field and its Client Secret in the "API token" field. The app needs the Graph application permission ' +
  'DeviceManagementConfiguration.ReadWrite.All (admin-consented) and an Intune license in the tenant.'

export const MISSING_TENANT_MESSAGE =
  'No Microsoft Entra tenant id — set the "Tenant ID" app setting (the directory/tenant GUID). It is ' +
  'required to acquire an access token.'

export interface IntuneResponse {
  status: number
  ok: boolean
  body: string
}

export type IntuneMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** OData collection envelope. */
export interface ODataEnvelope<T = unknown> {
  value?: T[]
  '@odata.nextLink'?: string
  '@odata.count'?: number
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

export class IntuneClient {
  private readonly graphBase: string
  private readonly tokenUrl: string
  private readonly resource: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number
  private cached: CachedToken | null = null

  constructor(opts: { profile: CloudProfile; tenantId: string; creds: IntuneCredentials; timeoutMs: number }) {
    this.graphBase = `https://${opts.profile.graphHost}/beta`
    this.tokenUrl = `https://${opts.profile.loginHost}/${opts.tenantId}/oauth2/v2.0/token`
    this.resource = `https://${opts.profile.graphHost}`
    this.clientId = opts.creds.clientId
    this.clientSecret = opts.creds.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  /** A Microsoft Graph (beta) request. */
  async request(
    method: IntuneMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<IntuneResponse> {
    return this.send(method, `${this.graphBase}${path}`, opts)
  }

  /** GET every page of a Graph OData collection, following `@odata.nextLink`. */
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
      res = await this.send('GET', next, {})
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  // ---- token + transport ----------------------------------------------------

  /** Acquire (and cache) a Graph bearer token. NON-UNION result. */
  private async acquireToken(): Promise<{ token: string | null; error: string | null }> {
    if (this.cached && this.cached.expiresAtMs > Date.now()) return { token: this.cached.token, error: null }

    const bodyParams = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: `${this.resource}/.default`,
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
      this.cached = { token: parsed.access_token, expiresAtMs: Date.now() + ttlMs - TOKEN_EXPIRY_BUFFER_MS }
      return { token: parsed.access_token, error: null }
    } catch (err) {
      return { token: null, error: err instanceof Error ? err.message : 'token request failed' }
    } finally {
      clearTimeout(timer)
    }
  }

  private async send(
    method: IntuneMethod,
    url: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<IntuneResponse> {
    const auth = await this.acquireToken()
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

function synthetic(reason: string): IntuneResponse {
  return { status: 0, ok: false, body: JSON.stringify({ error: { message: reason } }) }
}

/** Build a client from a credential and settings (tenant + cloud). */
export function buildIntuneClient(
  _hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: IntuneClient; graphHost: string; cloud: AzureCloud } | { error: string } {
  const creds = resolveIntuneCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readIntuneSettings(settings)
  if (!resolved.tenantId) return { error: MISSING_TENANT_MESSAGE }

  const profile = cloudProfile(resolved.cloud)
  return {
    client: new IntuneClient({ profile, tenantId: resolved.tenantId, creds, timeoutMs: resolved.timeoutMs }),
    graphHost: profile.graphHost,
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

/** Extract a human-readable error from a Graph error response. */
export function graphErrorMessage(res: IntuneResponse): string {
  const parsed = parseJson<{ error?: { message?: string; code?: string } | string }>(res.body)
  if (parsed?.error && typeof parsed.error === 'object') {
    return parsed.error.message || parsed.error.code || `HTTP ${res.status}`
  }
  if (typeof parsed?.error === 'string') return parsed.error
  return res.body || `HTTP ${res.status}`
}
