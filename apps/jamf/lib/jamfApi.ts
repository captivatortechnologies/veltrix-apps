// =============================================================================
// Jamf Pro API client.
//
// Auth is Basic-auth-for-a-bearer-token: a Jamf Pro "API-only" account's
// username + password (from a Veltrix credential) are exchanged for a Bearer
// token at:
//
//   POST https://<host>/api/v1/auth/token      Authorization: Basic base64(user:pass)
//     -> 200 { token: "<JWT>", expires: "<ISO-8601 timestamp>" }
//
// docs: https://developer.jamf.com/jamf-pro/reference/post_v1-auth-token
//
// The token is cached and reused until shortly before `expires`. Jamf Pro also
// supports an OAuth2 client-credentials flow for "API Roles and Clients"
// (Jamf Pro 10.49+): POST /api/v1/oauth/token, form-encoded
// grant_type=client_credentials&client_id=...&client_secret=...
// -> { access_token, token_type, expires_in, scope }
// (docs: https://developer.jamf.com/jamf-pro/reference/postoauthtoken /
// https://developer.jamf.com/jamf-pro/docs/client-credentials). That flow is
// NOT implemented here — this app authenticates with an API-only account's
// username/password, which works against every supported Jamf Pro version —
// and is left as a documented follow-up (see README).
//
// The modern API is a REST/JSON API rooted at https://<host>/api, versioned
// per-resource (this app uses /v1). Handlers run in-process, so this uses
// fetch with an AbortController timeout, never throws on an HTTP error
// status, and retries once on a 401 (the cached token may have been
// invalidated server-side) and on a 429 (Jamf does not document a rate limit,
// but a defensive backoff is harmless). Every parse/auth/response helper
// returns a NON-UNION { data, error } (or a fully-populated record) so
// callers narrow without help from the compiler or the platform's handler
// loader.
//
// --- Classic API (wave 2) ----------------------------------------------------
//
// Some Jamf Pro resources (computer groups, policies) are still Classic-API
// only — an older XML API rooted at https://<host>/JSSResource, e.g.
// https://developer.jamf.com/jamf-pro/reference/findcomputergroups and
// https://developer.jamf.com/jamf-pro/reference/findpoliciesbyid. `classicRequest`
// reuses the SAME cached Bearer token as the modern API: Jamf Pro's own
// `/v1/auth/token` doc states the token "functions as a Bearer token for all
// other Jamf Pro API endpoints", and Jamf Pro 10.35+ is documented (Bearer
// Token Authentication for Classic API) to accept it on Classic endpoints too.
// A handful of individual Classic reference pages in the current developer
// portal still list only "Basic Authentication" per operation — most likely
// stale/incomplete OpenAPI metadata rather than an actual runtime
// restriction — so `classicRequest` tries Bearer first and falls back to
// Basic auth (the credential's own username/password) on a 401, exactly once.
// This makes the client correct regardless of which claim holds on a given
// tenant, without fabricating a single unverified assumption as fact.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { classicErrorMessage } from './jamfClassicXml'

/** The subset of a component/connection target this client needs — permissive so a
 *  handler's live `ComponentRef` or a testConnection's lighter shape both satisfy it. */
export interface JamfTarget {
  hostname?: string | null
  port?: string | null
}

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PAGE_SIZE = 100
const MAX_LIST_PAGES = 500
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const DEFAULT_HTTPS_PORT = '443'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Settings ----------------------------------------------------------------

export interface JamfSettings {
  timeoutMs: number
  pageSize: number
}

export function readJamfSettings(settings: Record<string, unknown>): JamfSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  const rawPageSize = settings.page_size
  const pageSize =
    typeof rawPageSize === 'number' && Number.isFinite(rawPageSize) && rawPageSize > 0
      ? Math.floor(rawPageSize)
      : DEFAULT_PAGE_SIZE

  return { timeoutMs, pageSize }
}

// --- Credentials -------------------------------------------------------------

export interface JamfCredentials {
  username: string
  password: string
}

/**
 * Extract the Jamf Pro API-only account credentials from a Veltrix
 * credential: username in `username`, password in `password` (falling back
 * to `apiToken` for an operator who stored it there instead).
 */
export function resolveJamfCredentials(credential: CredentialRef | null): JamfCredentials | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  const password = (credential.password ?? credential.apiToken ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Jamf Pro credential — create an API-only account in Jamf Pro (Settings > System > User Accounts & Groups) ' +
  'with a privilege set granting Read/Create/Update/Delete for Scripts, Categories, Smart Computer Groups and ' +
  'Policies, then store its username in the credential "username" field and its password in the "password" field.'

export const MISSING_ENDPOINT_MESSAGE =
  'No Jamf Pro server configured — register a "jamf-pro-server" component whose hostname is your Jamf Pro server ' +
  '(e.g. yourcompany.jamfcloud.com, or an on-prem FQDN).'

// --- REST transport ------------------------------------------------------------

/** The `ApiError` envelope Jamf Pro returns on a 4xx/5xx JSON error response. */
export interface JamfApiErrorCause {
  code?: string
  field?: string
  description?: string
  id?: string
}
export interface JamfApiError {
  httpStatus?: number
  errors?: JamfApiErrorCause[]
}

/**
 * The outcome of one REST call. NON-UNION: every field is always present so a
 * handler reads `.error` / `.data` without control-flow narrowing (the
 * platform's handler loader does not narrow discriminated unions).
 *   - `error` is non-null for a network failure, a timeout, an auth failure,
 *     or a non-2xx HTTP status.
 *   - `data` is the parsed JSON body (null for a 204 No Content, or on error).
 */
export interface JamfApiResponse<T = unknown> {
  status: number
  data: T | null
  error: string | null
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

/** Search-results envelope shared by every `/v1/<resource>` list endpoint used here. */
export interface JamfSearchResults<T> {
  totalCount?: number
  results?: T[]
}

/** The outcome of one Classic API (XML) call. NON-UNION, mirroring {@link JamfApiResponse}. */
export interface JamfClassicResponse {
  status: number
  body: string
  error: string | null
}

type ClassicAuth = { kind: 'bearer'; token: string } | { kind: 'basic' }

export class JamfClient {
  private readonly apiBase: string
  private readonly classicBase: string
  private readonly username: string
  private readonly password: string
  private readonly timeoutMs: number
  private cachedToken: CachedToken | null = null

  constructor(opts: { apiBase: string; classicBase: string; creds: JamfCredentials; timeoutMs: number }) {
    this.apiBase = opts.apiBase
    this.classicBase = opts.classicBase
    this.username = opts.creds.username
    this.password = opts.creds.password
    this.timeoutMs = opts.timeoutMs
  }

  get baseUrl(): string {
    return this.apiBase
  }

  get classicBaseUrl(): string {
    return this.classicBase
  }

  /**
   * Execute one REST call against the Jamf Pro API. Acquires (and caches) a
   * Bearer token, retries once on a 401 (the token may have been invalidated
   * server-side — e.g. a password change) and on a 429 with backoff, and
   * returns a non-union response. Never throws on an HTTP error status.
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<JamfApiResponse<T>> {
    const auth = await this.acquireToken()
    if (!auth.token) {
      return { status: 0, data: null, error: auth.error ?? 'authentication failed' }
    }
    return this.requestWithToken(method, path, auth.token, body, { retriedAuth: false, rateLimitAttempts: 0 })
  }

  private async requestWithToken<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    token: string,
    body: unknown,
    state: { retriedAuth: boolean; rateLimitAttempts: number },
  ): Promise<JamfApiResponse<T>> {
    const url = `${this.apiBase}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.status === 401 && !state.retriedAuth) {
        // The cached token may have been invalidated server-side; force a
        // fresh acquisition and retry exactly once.
        this.cachedToken = null
        const auth = await this.acquireToken()
        if (!auth.token) return { status: 401, data: null, error: auth.error ?? 'authentication failed' }
        clearTimeout(timer)
        return this.requestWithToken(method, path, auth.token, body, { ...state, retriedAuth: true })
      }

      if (res.status === 429 && state.rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
        clearTimeout(timer)
        await sleep(RATE_LIMIT_BACKOFF_MS)
        return this.requestWithToken(method, path, token, body, {
          ...state,
          rateLimitAttempts: state.rateLimitAttempts + 1,
        })
      }

      if (res.status === 204) {
        return { status: res.status, data: null, error: null }
      }

      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, data: null, error: jamfErrorMessage(res.status, text) }
      }

      const parsed = parseJson<T>(text)
      if (text && parsed === null) {
        return { status: res.status, data: null, error: 'Jamf Pro returned a non-JSON response' }
      }
      return { status: res.status, data: parsed, error: null }
    } catch (err) {
      return { status: 0, data: null, error: err instanceof Error ? err.message : `${method} ${path} failed` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Page through a `/v1/<resource>` search endpoint, concatenating `results`. */
  async listAll<TNode = unknown>(
    path: string,
    pageSize: number,
  ): Promise<{ nodes: TNode[]; error: string | null }> {
    const nodes: TNode[] = []
    const size = pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE
    let totalCount: number | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const sep = path.includes('?') ? '&' : '?'
      const res = await this.request<JamfSearchResults<TNode>>(
        'GET',
        `${path}${sep}page=${page}&page-size=${size}&sort=name%3Aasc`,
      )
      if (res.error) return { nodes, error: res.error }
      const results = res.data?.results
      if (!Array.isArray(results)) return { nodes, error: `Jamf Pro response for "${path}" is missing "results"` }
      nodes.push(...results)
      totalCount = res.data?.totalCount
      if (results.length < size) break
      if (typeof totalCount === 'number' && nodes.length >= totalCount) break
    }
    return { nodes, error: null }
  }

  /**
   * Execute one Classic API (XML) call. Tries the cached Bearer token first;
   * on a 401 (or when no token could be acquired at all), falls back to plain
   * HTTP Basic auth exactly once — see the file header for why both paths
   * exist. Retries a 429 with backoff, same as {@link request}. Never throws
   * on an HTTP error status; `body` is the raw response text (XML, or an
   * error page) so callers parse it with `lib/jamfClassicXml.ts`.
   */
  async classicRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    bodyXml?: string,
  ): Promise<JamfClassicResponse> {
    const auth = await this.acquireToken()
    if (auth.token) {
      const viaBearer = await this.classicRequestOnce(method, path, bodyXml, { kind: 'bearer', token: auth.token }, 0)
      if (viaBearer.status !== 401) return viaBearer
    }
    return this.classicRequestOnce(method, path, bodyXml, { kind: 'basic' }, 0)
  }

  private async classicRequestOnce(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    bodyXml: string | undefined,
    auth: ClassicAuth,
    rateLimitAttempts: number,
  ): Promise<JamfClassicResponse> {
    const url = `${this.classicBase}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const authorization =
        auth.kind === 'bearer'
          ? `Bearer ${auth.token}`
          : `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/xml',
          ...(bodyXml !== undefined ? { 'Content-Type': 'application/xml' } : {}),
        },
        body: bodyXml,
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.status === 429 && rateLimitAttempts < MAX_RATE_LIMIT_RETRIES) {
        clearTimeout(timer)
        await sleep(RATE_LIMIT_BACKOFF_MS)
        return this.classicRequestOnce(method, path, bodyXml, auth, rateLimitAttempts + 1)
      }

      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, body: text, error: classicErrorMessage(res.status, text) }
      }
      return { status: res.status, body: text, error: null }
    } catch (err) {
      return { status: 0, body: '', error: err instanceof Error ? err.message : `${method} ${path} failed` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Acquire (and cache) a Bearer token via Basic auth. NON-UNION result. */
  private async acquireToken(): Promise<{ token: string | null; error: string | null }> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now()) {
      return { token: this.cachedToken.token, error: null }
    }

    const basic = Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.apiBase}/v1/auth/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await res.text()
      if (res.status < 200 || res.status >= 300) {
        return { token: null, error: `Jamf Pro token request failed: ${jamfErrorMessage(res.status, text)}` }
      }
      const parsed = parseJson<{ token?: string; expires?: string }>(text)
      if (!parsed?.token) {
        return { token: null, error: 'Jamf Pro token request failed: response had no "token"' }
      }
      const expiresAtMs = parsed.expires ? Date.parse(parsed.expires) : NaN
      const ttlValid = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
      this.cachedToken = {
        token: parsed.token,
        expiresAtMs: (ttlValid ? expiresAtMs : Date.now() + 20 * 60 * 1000) - TOKEN_EXPIRY_BUFFER_MS,
      }
      return { token: parsed.token, error: null }
    } catch (err) {
      return { token: null, error: err instanceof Error ? err.message : 'Jamf Pro token request failed' }
    } finally {
      clearTimeout(timer)
    }
  }
}

// --- Client construction -----------------------------------------------------

/**
 * Reduce a component hostname + port to a bare `<host>[:<port>]` — no scheme,
 * no path. Strips a protocol/path if present; keeps a non-default port for
 * on-prem installs (e.g. `:8443`), unlike a SaaS-only tenant host.
 */
function normalizeHostPort(hostname: string | undefined, port: string | undefined): string | null {
  let host = (hostname ?? '').trim()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
  if (!host) return null
  const p = (port ?? '').trim()
  return p && p !== DEFAULT_HTTPS_PORT ? `${host}:${p}` : host
}

/** The modern Jamf Pro API base URL (`https://<host>[:<port>]/api`). */
export function buildApiBase(hostname: string | undefined, port: string | undefined): string | null {
  const hostPort = normalizeHostPort(hostname, port)
  return hostPort ? `https://${hostPort}/api` : null
}

/** The Classic API base URL (`https://<host>[:<port>]/JSSResource`) — see the file header. */
export function buildClassicBase(hostname: string | undefined, port: string | undefined): string | null {
  const hostPort = normalizeHostPort(hostname, port)
  return hostPort ? `https://${hostPort}/JSSResource` : null
}

/** Build a client from a deploy-target component, a credential and settings. */
export function buildJamfClient(
  component: JamfTarget | null | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: JamfClient; apiBase: string } | { error: string } {
  const creds = resolveJamfCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const apiBase = buildApiBase(component?.hostname ?? undefined, component?.port ?? undefined)
  const classicBase = buildClassicBase(component?.hostname ?? undefined, component?.port ?? undefined)
  if (!apiBase || !classicBase) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readJamfSettings(settings)
  return {
    client: new JamfClient({ apiBase, classicBase, creds, timeoutMs: resolved.timeoutMs }),
    apiBase,
  }
}

// --- Shared helpers ----------------------------------------------------------

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Render a Jamf Pro `ApiError` body (or any error body) as one readable line. */
export function jamfErrorMessage(status: number, body: string): string {
  const parsed = parseJson<JamfApiError>(body)
  const causes = parsed?.errors
  if (Array.isArray(causes) && causes.length > 0) {
    const detail = causes
      .map((c) => [c.field, c.description || c.code].filter(Boolean).join(': '))
      .filter((s) => s.length > 0)
      .join('; ')
    if (detail) return `HTTP ${status}: ${detail}`
  }
  const trimmed = (body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return `HTTP ${status}`
  return `HTTP ${status}: ${trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed}`
}
