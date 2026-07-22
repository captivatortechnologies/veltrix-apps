// =============================================================================
// Microsoft Sentinel (Azure Resource Manager) client.
//
// Microsoft Sentinel is managed through Azure Resource Manager (ARM), NOT
// Microsoft Graph. Every configurable object is an ARM resource under
//   /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/
//   workspaces/{ws}/providers/Microsoft.SecurityInsights/...
//
// Auth is Azure AD OAuth2 client-credentials: an Entra app registration's
// client id + secret (from a Veltrix credential) are exchanged for a bearer
// token at https://<loginHost>/{tenantId}/oauth2/v2.0/token with the ARM scope
// https://<armHost>/.default (management.azure.com for commercial/GCC,
// management.usgovcloudapi.net for GCC-High/DoD). Tokens live ~1h and are cached.
//
// The service principal needs the "Microsoft Sentinel Contributor" role
// (Microsoft.SecurityInsights/*) scoped to the workspace's resource group.
//
// api-version is pinned app-wide to the GA release 2024-09-01 — GA for alert
// rules, automation rules and watchlists (watchlist PUT/DELETE became
// asynchronous at 2024-09-01, which the provisioning-state poller handles).
//
// Handlers run in-process, so this uses fetch with an AbortController timeout,
// never throws on an HTTP error status, and honors 429 Retry-After.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const MAX_RATE_LIMIT_WAIT_MS = 30_000
const TOKEN_EXPIRY_BUFFER_MS = 60_000

/** Pinned GA api-version for all Microsoft.SecurityInsights resources. */
export const SENTINEL_API_VERSION = '2024-09-01'
/** api-version for the Log Analytics workspace probe (Microsoft.OperationalInsights). */
export const WORKSPACE_API_VERSION = '2023-09-01'

/** Bounded async-op poll window for watchlists (provisioningState → Succeeded). */
const POLL_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 2_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type AzureCloud = 'commercial' | 'gcc' | 'gcc-high' | 'dod'

export interface CloudProfile {
  loginHost: string
  /** ARM host — also the token audience. */
  armHost: string
}

/**
 * Per-cloud login + ARM hosts. GCC (moderate) runs on commercial Azure ARM
 * (management.azure.com); GCC-High / DoD use the sovereign ARM endpoint
 * management.usgovcloudapi.net with the login.microsoftonline.us authority.
 */
export function cloudProfile(cloud: AzureCloud): CloudProfile {
  switch (cloud) {
    case 'gcc-high':
    case 'dod':
      return { loginHost: 'login.microsoftonline.us', armHost: 'management.usgovcloudapi.net' }
    case 'gcc':
    case 'commercial':
    default:
      return { loginHost: 'login.microsoftonline.com', armHost: 'management.azure.com' }
  }
}

export interface SentinelSettings {
  tenantId: string | null
  subscriptionId: string | null
  resourceGroup: string | null
  workspaceName: string | null
  cloud: AzureCloud
  timeoutMs: number
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function readSentinelSettings(settings: Record<string, unknown>): SentinelSettings {
  const rawCloud = typeof settings.azure_cloud === 'string' ? settings.azure_cloud.trim().toLowerCase() : ''
  const cloud: AzureCloud =
    rawCloud === 'gcc' || rawCloud === 'gcc-high' || rawCloud === 'dod' ? (rawCloud as AzureCloud) : 'commercial'

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout * 1000 : REQUEST_TIMEOUT_MS

  return {
    tenantId: readString(settings.tenant_id),
    subscriptionId: readString(settings.subscription_id),
    resourceGroup: readString(settings.resource_group),
    workspaceName: readString(settings.workspace_name),
    cloud,
    timeoutMs,
  }
}

export interface SentinelCredentials {
  clientId: string
  clientSecret: string
}

/** Extract the Entra app-registration client id + secret: Client ID in `username`, secret in `apiToken`/`password`. */
export function resolveSentinelCredentials(credential: CredentialRef | null): SentinelCredentials | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Microsoft Entra app credential — store the app registration Client ID in the credential "username" ' +
  'field and its Client Secret in the "API token" field. The service principal needs the "Microsoft Sentinel ' +
  'Contributor" role (Microsoft.SecurityInsights/*) scoped to the workspace resource group.'

export const MISSING_WORKSPACE_MESSAGE =
  'Incomplete workspace address — set the "Tenant ID", "Subscription ID", "Resource Group" and "Workspace Name" ' +
  'app settings. All four are required to reach the Microsoft Sentinel workspace via Azure Resource Manager.'

export interface SentinelResponse {
  status: number
  ok: boolean
  body: string
}

export type SentinelMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** ARM collection envelope. */
export interface ArmCollection<T = unknown> {
  value?: T[]
  nextLink?: string
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

/** Terminal ARM provisioning states. */
const TERMINAL_STATES = new Set(['Succeeded', 'Failed', 'Canceled'])

export interface PollResult {
  ok: boolean
  state: string | null
  error: string | null
}

export class SentinelClient {
  private readonly armBase: string
  private readonly tokenUrl: string
  private readonly resource: string
  private readonly subscriptionId: string
  private readonly workspaceScope: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number
  private cached: CachedToken | null = null

  constructor(opts: {
    profile: CloudProfile
    tenantId: string
    subscriptionId: string
    resourceGroup: string
    workspaceName: string
    creds: SentinelCredentials
    timeoutMs: number
  }) {
    this.armBase = `https://${opts.profile.armHost}`
    this.tokenUrl = `https://${opts.profile.loginHost}/${opts.tenantId}/oauth2/v2.0/token`
    this.resource = `https://${opts.profile.armHost}`
    this.subscriptionId = opts.subscriptionId
    this.workspaceScope =
      `/subscriptions/${opts.subscriptionId}` +
      `/resourceGroups/${opts.resourceGroup}` +
      `/providers/Microsoft.OperationalInsights/workspaces/${opts.workspaceName}`
    this.clientId = opts.creds.clientId
    this.clientSecret = opts.creds.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  /** The Log Analytics workspace resource path (for the connectivity probe). */
  workspacePath(): string {
    return this.workspaceScope
  }

  /** The subscription-scope ARM path, for subscription-level providers (e.g. Microsoft.Insights Activity Log). */
  subscriptionPath(): string {
    return `/subscriptions/${this.subscriptionId}`
  }

  /** Build a Microsoft.SecurityInsights child-resource path, e.g. sentinelPath('/alertRules/foo'). */
  sentinelPath(suffix: string): string {
    return `${this.workspaceScope}/providers/Microsoft.SecurityInsights${suffix}`
  }

  /** An ARM request. `apiVersion` is appended as ?api-version=; body is JSON-encoded. PUT is an upsert. */
  async request(
    method: SentinelMethod,
    path: string,
    opts: { apiVersion: string; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {
      apiVersion: SENTINEL_API_VERSION,
    },
  ): Promise<SentinelResponse> {
    const target = new URL(`${this.armBase}${path}`)
    target.searchParams.set('api-version', opts.apiVersion)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) target.searchParams.set(key, String(value))
    }
    return this.send(method, target.toString(), opts.body)
  }

  /** GET every page of an ARM collection, following `nextLink`. */
  async getAll<T = unknown>(
    path: string,
    apiVersion: string,
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let res = await this.request('GET', path, { apiVersion })
    let lastStatus = res.status
    let lastBody = res.body
    const maxPages = 50
    for (let page = 0; page < maxPages; page++) {
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<ArmCollection<T>>(res.body)
      if (Array.isArray(env?.value)) items.push(...env!.value!)
      const next = env?.nextLink
      if (!next) break
      res = await this.send('GET', next, undefined)
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  /**
   * Poll a resource's provisioningState until it reaches a terminal state or the
   * bounded window elapses. Used after an asynchronous watchlist PUT/DELETE.
   */
  async pollProvisioning(path: string, apiVersion: string): Promise<PollResult> {
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let lastState: string | null = null
    while (Date.now() < deadline) {
      const res = await this.request('GET', path, { apiVersion })
      if (res.status === 404) {
        // A deletion that completed, or a resource not yet visible.
        return { ok: true, state: 'Deleted', error: null }
      }
      if (!res.ok) {
        return { ok: false, state: lastState, error: armErrorMessage(res) }
      }
      const parsed = parseJson<{ properties?: { provisioningState?: string } }>(res.body)
      lastState = parsed?.properties?.provisioningState ?? null
      if (lastState && TERMINAL_STATES.has(lastState)) {
        if (lastState === 'Succeeded') return { ok: true, state: lastState, error: null }
        return { ok: false, state: lastState, error: `provisioning state ${lastState}` }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    // Timed out before a terminal state — surface the last observed state.
    return { ok: false, state: lastState, error: `timed out waiting for provisioning to complete (last state: ${lastState ?? 'unknown'})` }
  }

  // ---- token + transport ----------------------------------------------------

  /** Acquire (and cache) an ARM bearer token. NON-UNION result. */
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

  private async send(method: SentinelMethod, url: string, body: unknown): Promise<SentinelResponse> {
    const auth = await this.acquireToken()
    if (!auth.token) return synthetic(auth.error ?? 'authentication failed')

    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${auth.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
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

function synthetic(reason: string): SentinelResponse {
  return { status: 0, ok: false, body: JSON.stringify({ error: { message: reason } }) }
}

/** Build a client from a credential and settings (tenant + workspace triple + cloud). */
export function buildSentinelClient(
  _hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: SentinelClient; armHost: string; cloud: AzureCloud } | { error: string } {
  const creds = resolveSentinelCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readSentinelSettings(settings)
  if (!resolved.tenantId || !resolved.subscriptionId || !resolved.resourceGroup || !resolved.workspaceName) {
    return { error: MISSING_WORKSPACE_MESSAGE }
  }

  const profile = cloudProfile(resolved.cloud)
  return {
    client: new SentinelClient({
      profile,
      tenantId: resolved.tenantId,
      subscriptionId: resolved.subscriptionId,
      resourceGroup: resolved.resourceGroup,
      workspaceName: resolved.workspaceName,
      creds,
      timeoutMs: resolved.timeoutMs,
    }),
    armHost: profile.armHost,
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

/** Extract a human-readable error from an ARM error response. */
export function armErrorMessage(res: SentinelResponse): string {
  const parsed = parseJson<{ error?: { message?: string; code?: string } | string }>(res.body)
  if (parsed?.error && typeof parsed.error === 'object') {
    return parsed.error.message || parsed.error.code || `HTTP ${res.status}`
  }
  if (typeof parsed?.error === 'string') return parsed.error
  return res.body || `HTTP ${res.status}`
}

/**
 * Deterministic URL-safe slug used as the ARM resource name (ruleId) for alert
 * and automation rules. The same display name always maps to the same slug, so
 * the PUT is idempotent (re-deploying a rule updates it in place).
 */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'rule'
  )
}

/** ISO-8601 duration matcher (e.g. PT1H, P2DT1H30M) — permissive, requires at least one component. */
export const ISO8601_DURATION_RE = /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/

/** True when a string is a plausible ISO-8601 duration with at least one time/day component. */
export function isIso8601Duration(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === 'P' || trimmed === 'PT' || !ISO8601_DURATION_RE.test(trimmed)) return false
  return /\d/.test(trimmed)
}
