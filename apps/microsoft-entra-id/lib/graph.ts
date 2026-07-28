// =============================================================================
// Microsoft Graph API client for the Entra ID (Azure AD) app.
//
// Auth is OAuth2 client-credentials against an Entra app registration:
//   POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
//   grant_type=client_credentials, scope=https://graph.microsoft.com/.default
// The returned bearer token is cached until ~1 min before expiry.
//
// Convention for the Veltrix credential:
//   username -> app registration (client) ID
//   password -> client secret
//   tenant   -> the `tenant_id` app setting (a GUID or verified domain)
//
// All routes are under https://graph.microsoft.com/v1.0. Graph rate-limits with
// 429 + a `Retry-After` header (seconds); this retries once. Handlers run
// in-process in the platform's Node runtime, so this uses fetch with an
// AbortController timeout and no external HTTP dependency. It never throws on an
// HTTP error status — callers inspect `status` so a 404 (object absent) is
// distinguishable from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const LOGIN_BASE = 'https://login.microsoftonline.com'
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'
/** Refresh the token this many ms before its stated expiry. */
const TOKEN_SKEW_MS = 60_000

export interface GraphSettings {
  timeoutMs: number
  tenantId: string | null
}

export function readGraphSettings(settings: Record<string, unknown>): GraphSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawTenant = settings.tenant_id
  const tenantId = typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : null
  return { timeoutMs, tenantId }
}

export interface GraphCredential {
  tenantId: string
  clientId: string
  clientSecret: string
}

/**
 * Resolve the Entra app-registration credential. Returns null if any of the
 * three required parts is missing so callers can surface MISSING_CREDENTIAL_MESSAGE.
 */
export function resolveGraphCredential(
  credential: CredentialRef | null,
  settings: GraphSettings
): GraphCredential | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.password ?? '').trim()
  const tenantId = (settings.tenantId ?? '').trim()
  if (!clientId || !clientSecret || !tenantId) return null
  return { tenantId, clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Microsoft Entra credential — this app authenticates as an Entra app ' +
  'registration via OAuth2 client credentials. Store the application (client) ID in the ' +
  'credential "username" field and a client secret in "password", and set the directory ' +
  '(tenant) ID in the app\'s "Tenant ID" setting. The app registration needs the Graph ' +
  'application permissions for what this app manages (e.g. Policy.ReadWrite.ConditionalAccess, ' +
  'Group.ReadWrite.All), granted admin consent.'

export interface GraphResponse {
  status: number
  ok: boolean
  body: string
  /** `@odata.nextLink` from the JSON body, when the collection is paginated. */
  nextUrl: string | null
}

export type GraphMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class GraphClient {
  private readonly cred: GraphCredential
  private readonly timeoutMs: number
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(opts: { cred: GraphCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  /** Acquire (and cache) a bearer token. Returns an error string on failure. */
  private async ensureToken(): Promise<{ token?: string; error?: string }> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) {
      return { token: this.token }
    }
    const url = `${LOGIN_BASE}/${encodeURIComponent(this.cred.tenantId)}/oauth2/v2.0/token`
    const form = new URLSearchParams({
      client_id: this.cred.clientId,
      client_secret: this.cred.clientSecret,
      scope: GRAPH_SCOPE,
      grant_type: 'client_credentials',
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      })
      const body = await res.text()
      if (!res.ok) {
        const parsed = parseJson<{ error_description?: string; error?: string }>(body)
        return { error: parsed?.error_description || parsed?.error || `token request failed (${res.status})` }
      }
      const parsed = parseJson<{ access_token?: string; expires_in?: number }>(body)
      if (!parsed?.access_token) return { error: 'token response missing access_token' }
      this.token = parsed.access_token
      this.tokenExpiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000
      return { token: this.token }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'token request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Make a Graph request. `path` is either an absolute URL (e.g. a nextLink) or a
   *  `/v1.0`-relative path like `/identity/conditionalAccess/policies`. `opts.headers`
   *  merges over (and can override) the default headers — e.g. the `Accept-Language`
   *  header the organizational-branding default-locale PUT requires. */
  async request(
    method: GraphMethod,
    path: string,
    body?: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<GraphResponse> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) {
      return { status: 0, ok: false, body: auth.error ?? 'no token', nextUrl: null }
    }
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path.startsWith('/') ? path : `/${path}`}`

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(opts?.headers ?? {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await res.text()

        // Retry once on 429, honoring Retry-After (seconds), capped.
        if (res.status === 429 && attempt === 0) {
          const retryAfter = Number(res.headers.get('Retry-After'))
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : 1000
          await sleep(waitMs)
          continue
        }

        let nextUrl: string | null = null
        const parsed = parseJson<{ '@odata.nextLink'?: string }>(text)
        if (parsed && typeof parsed['@odata.nextLink'] === 'string') {
          nextUrl = parsed['@odata.nextLink']
        }
        return { status: res.status, ok: res.ok, body: text, nextUrl }
      } catch (err) {
        if (attempt === 0) continue
        return {
          status: 0,
          ok: false,
          body: err instanceof Error ? err.message : 'request error',
          nextUrl: null,
        }
      } finally {
        clearTimeout(timer)
      }
    }
    return { status: 0, ok: false, body: 'request failed', nextUrl: null }
  }

  get(path: string): Promise<GraphResponse> {
    return this.request('GET', path)
  }
  post(path: string, body: unknown): Promise<GraphResponse> {
    return this.request('POST', path, body)
  }
  patch(path: string, body: unknown): Promise<GraphResponse> {
    return this.request('PATCH', path, body)
  }
  put(path: string, body: unknown, opts?: { headers?: Record<string, string> }): Promise<GraphResponse> {
    return this.request('PUT', path, body, opts)
  }
  delete(path: string): Promise<GraphResponse> {
    return this.request('DELETE', path)
  }

  /**
   * GET a collection following `@odata.nextLink` pagination.
   *
   * `truncated` is true when the page budget ran out while more pages remained —
   * i.e. the returned `items` is an INCOMPLETE view of the collection. Callers that
   * infer "declared object is absent" from a full listing MUST NOT treat a missing
   * item as absent when `truncated` is set (it may simply be on an unfetched page),
   * or they raise false "absent" drift / create duplicates. The cap bounds latency;
   * at Graph's default page size it now covers ~10k objects before truncating.
   */
  async getAll<T = unknown>(
    path: string,
    maxPages = 100,
  ): Promise<{ ok: boolean; items: T[]; truncated: boolean; lastError?: GraphResponse }> {
    const items: T[] = []
    let next: string | null = path
    let page = 0
    for (; page < maxPages && next; page++) {
      const res: GraphResponse = await this.get(next)
      if (!res.ok) return { ok: false, items, truncated: false, lastError: res }
      const parsed = parseJson<{ value?: T[]; '@odata.nextLink'?: string }>(res.body)
      if (parsed?.value) items.push(...parsed.value)
      next = res.nextUrl
    }
    // Stopped because the page budget ran out with a nextLink still pending.
    return { ok: true, items, truncated: next !== null }
  }
}

export function buildGraphClient(cred: GraphCredential, settings: GraphSettings): GraphClient {
  return new GraphClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Extract a human-readable message from a Graph error response body. */
export function graphErrorMessage(resp: GraphResponse): string {
  const parsed = parseJson<{ error?: { message?: string; code?: string } }>(resp.body)
  if (parsed?.error?.message) {
    return parsed.error.code ? `${parsed.error.code}: ${parsed.error.message}` : parsed.error.message
  }
  return resp.body?.slice(0, 300) || `Graph request failed (status ${resp.status})`
}
