// =============================================================================
// OneLogin API client for the onelogin app.
//
// Auth: a OneLogin "API Credential" (OAuth2 client_credentials grant) —
//   Token:  POST https://<subdomain>.onelogin.com/auth/oauth2/v2/token
//           header: Authorization: Basic base64(client_id:client_secret)
//           body:   {"grant_type":"client_credentials"} (application/json)
//           resp:   { access_token, token_type, expires_in, account_id, ... }
//   API:    https://<subdomain>.onelogin.com/api/2/...  (most resources)
//           https://<subdomain>.onelogin.com/api/1/...  (legacy resources —
//           Privileges — OneLogin never migrated these to v2)
//           header: Authorization: bearer <access_token>
// Verified directly against developers.onelogin.com:
//   - Token endpoint:  /api-docs/2/oauth20-tokens/generate-tokens-2
//   - API domain:      /api-docs/2/getting-started/dev-overview ("<subdomain>
//                       .onelogin.com" — the same host used to log in; OneLogin
//                       has no separate regional API host to select, unlike
//                       Okta/PingOne)
//   - Pagination:      /api-docs/2/getting-started/using-query-parameters —
//                       v2 endpoints (Apps/Roles/Mappings/App Rules/Brands)
//                       page via a `Link: <url>; rel="next"` response header;
//                       the legacy v1 Privileges endpoints instead return a
//                       body envelope `{ <key>: [...], nextLink, afterCursor }`
//                       (seen on /api-docs/1/privileges/get-roles) — getAll()
//                       below handles BOTH shapes.
//
// Access tokens default to a 10-hour lifetime; this client caches one per API
// credential and refreshes with headroom. Handlers run in-process in the
// platform's Node runtime, so this uses fetch with an AbortController timeout
// and no external HTTP dependency. request() never throws on an HTTP error
// status — callers inspect `status` so they can tell a 404 (object absent)
// from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** Refresh the cached token when less than this remains of its lifetime. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** OneLogin access tokens default to 36000s (10h); used when the response omits expires_in. */
const DEFAULT_TOKEN_TTL_SECONDS = 36_000

// --- Settings -------------------------------------------------------------

export interface OneLoginSettings {
  timeoutMs: number
}

/** Read and normalize the app settings that drive OneLogin API access. */
export function readOneLoginSettings(settings: Record<string, unknown>): OneLoginSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30
  return { timeoutMs: timeoutSeconds * 1000 }
}

// --- Credentials -----------------------------------------------------------

export interface OneLoginApiCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the OneLogin API Credential (Client ID / Client Secret) from a
 * Veltrix credential. Convention (mirrors ping-identity / okta-identity):
 * Client ID in "username", Client Secret in "API token" (preferred) or
 * "password".
 */
export function resolveOneLoginCredentials(credential: CredentialRef | null): OneLoginApiCredentials | null {
  if (!credential) return null
  const clientId = credential.username?.trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No OneLogin API credentials available - store the API credential\'s Client ID in the credential ' +
  '"username" field and its Client Secret in the "API token" field. Create an API credential under ' +
  'Developers > API Credentials in the OneLogin admin console, scoped to "Manage All" (or a narrower ' +
  'scope covering the resources this app manages).'

/**
 * Extract the OneLogin account domain from a connection. Convention (mirrors
 * okta-identity's org-domain-as-hostname): the domain is stored as the
 * deploy-target component's hostname (surfaced in ConnectionsManager as the
 * "endpoint" field) — either a bare subdomain ("acme") or the full domain
 * ("acme.onelogin.com").
 */
export function resolveOneLoginDomain(hostname: string | null | undefined): string | null {
  const trimmed = hostname?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!trimmed) return null
  return trimmed.includes('.') ? trimmed : `${trimmed}.onelogin.com`
}

export const MISSING_DOMAIN_MESSAGE =
  'No OneLogin account is registered for this connection yet - set the connection\'s endpoint to your ' +
  'OneLogin subdomain (e.g. "acme" or "acme.onelogin.com" - the same address you use to log in), and ' +
  'save the connection.'

// --- HTTP client -------------------------------------------------------------

export interface OneLoginResponse {
  status: number
  ok: boolean
  body: string
  /** The `Link` response header (RFC 5988), when present — used for pagination. */
  linkHeader: string | null
}

export type OneLoginMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Tokens live up to 10 hours; cache per (domain, clientId+secret) so
// consecutive pipeline handlers (validate -> deploy -> healthCheck) reuse one
// token instead of re-authenticating on every call.
const tokenCache = new Map<string, CachedToken>()

export class OneLoginClient {
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number

  constructor(opts: { domain: string; credentials: OneLoginApiCredentials; timeoutMs: number }) {
    this.baseUrl = `https://${opts.domain}`
    this.clientId = opts.credentials.clientId
    this.clientSecret = opts.credentials.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.baseUrl}|${this.clientId}|${this.clientSecret}`
  }

  /** POST {baseUrl}/auth/oauth2/v2/token - HTTP Basic client_credentials grant. */
  private async authenticate(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey())
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken
    }

    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`, 'utf8').toString('base64')
    const res = await this.rawFetch(`${this.baseUrl}/auth/oauth2/v2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    })

    if (!res.ok) {
      throw new Error(
        `OneLogin authentication failed against ${this.baseUrl}: ${oneLoginErrorMessage(res)}. ` +
          'Check the API credential Client ID/Secret and the account domain.',
      )
    }

    const parsed = parseJson<{ access_token?: string; expires_in?: number }>(res.body)
    if (!parsed?.access_token) {
      throw new Error(`OneLogin authentication returned no access_token (HTTP ${res.status})`)
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
   * Perform a request against {baseUrl}{path} (path must include the /api/1
   * or /api/2 prefix). Never throws on an HTTP error status - callers inspect
   * `status`. Retries once on 401 (expired/revoked token). Throws on network
   * errors, timeout, and authentication failure.
   */
  async request(
    method: OneLoginMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<OneLoginResponse> {
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
   * GET a list endpoint and follow pagination to completion, returning every
   * item. Handles both shapes OneLogin uses (see the file header):
   *   - a bare JSON array, paged via a `Link: <url>; rel="next"` header
   *     (every v2 endpoint this app calls: Apps/Roles/Mappings/App
   *     Rules/Brands)
   *   - a body envelope `{ [arrayKey]: [...], nextLink }`, paged via the
   *     envelope's own `nextLink` field (the legacy v1 Privileges endpoints)
   * `arrayKey` is only needed for the second shape.
   */
  async getAll<T = unknown>(
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; arrayKey?: string } = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let nextUrl: string | null = null
    let firstPage = true
    let lastStatus = 0
    let lastBody = ''

    while (firstPage || nextUrl) {
      const res: OneLoginResponse = nextUrl
        ? await this.sendAbsolute('GET', nextUrl)
        : await this.request('GET', path, { query: opts.query })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }

      const parsed = parseJson<unknown>(res.body)
      if (Array.isArray(parsed)) {
        items.push(...(parsed as T[]))
        nextUrl = parseLinkHeaderNext(res.linkHeader)
      } else if (parsed && typeof parsed === 'object' && opts.arrayKey) {
        const envelope = parsed as Record<string, unknown>
        const page = envelope[opts.arrayKey]
        if (Array.isArray(page)) items.push(...(page as T[]))
        nextUrl = typeof envelope.nextLink === 'string' ? envelope.nextLink : parseLinkHeaderNext(res.linkHeader)
      } else {
        nextUrl = null
      }
      firstPage = false
    }

    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async send(
    method: OneLoginMethod,
    path: string,
    token: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<OneLoginResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.fetchUrl(method, url.toString(), token, opts.body)
  }

  private async sendAbsolute(method: OneLoginMethod, absoluteUrl: string): Promise<OneLoginResponse> {
    const token = await this.authenticate()
    return this.fetchUrl(method, absoluteUrl, token, undefined)
  }

  private async fetchUrl(method: OneLoginMethod, url: string, token: string, body: unknown): Promise<OneLoginResponse> {
    return this.rawFetch(url, {
      method,
      headers: {
        Authorization: `bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<OneLoginResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const text = await res.text()
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        body: text,
        linkHeader: res.headers.get('link'),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build a OneLogin client from a component hostname (holding the account
 * domain), a credential (API Credential Client ID/Secret) and app settings
 * (timeout). Returns a descriptive `error` instead of throwing so every
 * handler can surface one consistent message.
 */
export function buildOneLoginClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: OneLoginClient; domain: string } | { error: string } {
  const credentials = resolveOneLoginCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }

  const domain = resolveOneLoginDomain(hostname)
  if (!domain) return { error: MISSING_DOMAIN_MESSAGE }

  const resolved = readOneLoginSettings(settings)
  return {
    client: new OneLoginClient({ domain, credentials, timeoutMs: resolved.timeoutMs }),
    domain,
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

/**
 * Extract a human-readable error from a OneLogin error response body.
 * OneLogin's error envelope varies by API generation - this checks every
 * shape actually documented across developers.onelogin.com (a top-level
 * `message`, an OAuth-style `error_description`, and the classic v1
 * `status.message`) before falling back to the raw body.
 */
export function oneLoginErrorMessage(res: OneLoginResponse): string {
  const parsed = parseJson<{
    message?: string
    error_description?: string
    error?: string
    statusMessage?: string
    status?: { message?: string; error?: boolean; code?: number }
  }>(res.body)
  if (parsed?.message) return parsed.message
  if (parsed?.error_description) return parsed.error_description
  if (parsed?.status?.message) return parsed.status.message
  if (parsed?.statusMessage) return parsed.statusMessage
  if (parsed?.error) return parsed.error
  return res.body || `HTTP ${res.status}`
}

/** Parse an RFC 5988 `Link` header and return the `rel="next"` URL, if any. */
export function parseLinkHeaderNext(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim())
    if (match) return match[1]
  }
  return null
}

/** Deterministic JSON stringify with recursively sorted object keys - for drift comparisons. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/**
 * Reconcile a full ordered id list (`liveOrder`, ALL ids OneLogin currently
 * knows about, in current position order) so that:
 *   - every id NOT in `managedIds` keeps its existing relative order
 *     (out-of-band objects this app does not own are never reordered)
 *   - the ids in `managedIds` appear, in EXACTLY the order given, re-inserted
 *     at the position of the first managed id that already existed in
 *     `liveOrder` (or appended at the end when every managed id is new)
 * Used by mappings/app-rules deploy, whose OneLogin `.../sort` endpoint
 * requires the COMPLETE id list on every call (a partial list 422s) - so a
 * canvas that only declares SOME of the account's mappings/rules must still
 * submit a full, non-destructive order.
 */
export function reconcileOrder(liveOrder: string[], managedIds: string[]): string[] {
  const managedSet = new Set(managedIds)
  const unmanaged = liveOrder.filter((id) => !managedSet.has(id))
  const firstManagedLiveIndex = liveOrder.findIndex((id) => managedSet.has(id))

  if (firstManagedLiveIndex === -1) {
    // None of the managed ids pre-existed in liveOrder (all newly created) -
    // append them at the end, after every unmanaged id.
    return [...unmanaged, ...managedIds]
  }

  // Count how many unmanaged ids precede the first managed id's original
  // position - that is where the managed block gets re-inserted.
  let insertAt = 0
  for (let i = 0; i < firstManagedLiveIndex; i++) {
    if (!managedSet.has(liveOrder[i])) insertAt++
  }

  return [...unmanaged.slice(0, insertAt), ...managedIds, ...unmanaged.slice(insertAt)]
}
