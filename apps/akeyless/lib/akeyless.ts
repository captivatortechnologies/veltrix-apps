// =============================================================================
// Akeyless API client for the akeyless app.
//
// Transport: a plain REST/JSON API over HTTPS - every operation is a single
// POST with a JSON body, no path parameters and no verb-specific methods.
// This is exactly the in-process `fetch()`-only shape the platform's app
// runtime requires (no subprocess, no compiled binary, no non-SDK runtime
// dependency) - confirmed directly against the OpenAPI spec published at
// https://github.com/akeylesslabs/technical-documentation (host: api.akeyless.io,
// schemes: [https]) and cross-checked against the actively-maintained
// akeyless-community/terraform-provider-akeyless source, which exercises the
// same endpoints through the official akeyless-go SDK.
//
// Auth: POST /auth with { "access-id", "access-key", "access-type": "access_key" }
//   -> { token, expiration, creds } (https://docs.akeyless.io, operation `auth`).
//   The returned `token` is NOT sent as a header - every subsequent call must
//   include it as a `token` field inside that call's own JSON body (this is
//   the one Akeyless-specific quirk every handler in this app relies on).
// Base URL: the connection's endpoint is always the Akeyless API host - enter
//   "api.akeyless.io" for the public SaaS control plane, or a private
//   Akeyless Gateway's URL for accounts managed through a self-hosted
//   Gateway (some of this app's config types - Kubernetes Gateway Auth
//   Config, Gateway Allowed Access - are gateway-scoped operations that may
//   need to target a specific Gateway's API). The platform requires a
//   non-empty endpoint to register this connection's deploy-target
//   component, so resolveAkeylessBaseUrl's DEFAULT_BASE_URL fallback below
//   is only a defensive last resort, never the expected path.
// Error envelope: `{"error": "<message>"}` (OpenAPI `JSONError`, definitions
//   -> JSONError) - every non-2xx response uses this one shape.
//
// Akeyless does not document a fixed access-token TTL in the OpenAPI schema
// (`expiration` is a free-form string whose format is not specified). To
// avoid parsing an unspecified format, this client caches a token for a
// conservative fixed window and unconditionally retries once on 401 (mirrors
// the retry-on-401 pattern used by every other Veltrix app's API client).
// Handlers run in-process in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const DEFAULT_BASE_URL = 'https://api.akeyless.io'
const REQUEST_TIMEOUT_MS = 30_000
/** Conservative token cache lifetime - Akeyless does not document a fixed TTL. */
const TOKEN_CACHE_MS = 30 * 60_000

// --- Settings ----------------------------------------------------------------

export interface AkeylessSettings {
  timeoutMs: number
}

/** Read and normalize the app settings that drive Akeyless API access. */
export function readAkeylessSettings(settings: Record<string, unknown>): AkeylessSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30
  return { timeoutMs: timeoutSeconds * 1000 }
}

// --- Credentials ---------------------------------------------------------------

export interface AkeylessCredentials {
  accessId: string
  accessKey: string
}

/**
 * Extract the Akeyless Access ID / Access Key auth-method credential from a
 * Veltrix credential. Convention (mirrors every other Veltrix secrets/IAM
 * app): Access ID in "username", Access Key in "API token" (preferred) or
 * "password".
 */
export function resolveAkeylessCredentials(credential: CredentialRef | null): AkeylessCredentials | null {
  if (!credential) return null
  const accessId = credential.username?.trim()
  const accessKey = (credential.apiToken ?? credential.password ?? '').trim()
  if (!accessId || !accessKey) return null
  return { accessId, accessKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Akeyless credentials available - store an Akeyless API Key auth method\'s Access ID in the ' +
  'credential "username" field and its Access Key in the "API token" field. Create an API Key auth ' +
  'method (Auth Methods -> New -> API Key) in the Akeyless Console, and associate it with a role that ' +
  'covers the resources this app manages (Admin, or a scoped role with read/write on auth methods, ' +
  'roles, targets, dynamic secrets, rotated secrets, event forwarders and gateway configuration).'

/**
 * Resolve the Akeyless API base URL from a connection. Defaults to the
 * public SaaS control plane; an operator may override it to point at a
 * private Akeyless Gateway's admin API (see file header).
 */
export function resolveAkeylessBaseUrl(endpoint: string | null | undefined): string {
  const trimmed = endpoint?.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE_URL
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

// --- HTTP client ---------------------------------------------------------------

export interface AkeylessResponse {
  status: number
  ok: boolean
  body: string
}

interface CachedToken {
  token: string
  cachedAt: number
}

// Tokens are cached per (baseUrl, accessId+accessKey) so consecutive pipeline
// handlers (validate -> deploy -> healthCheck) reuse one token instead of
// re-authenticating on every call.
const tokenCache = new Map<string, CachedToken>()

export class AkeylessClient {
  private readonly baseUrl: string
  private readonly accessId: string
  private readonly accessKey: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: AkeylessCredentials; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.accessId = opts.credentials.accessId
    this.accessKey = opts.credentials.accessKey
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.baseUrl}|${this.accessId}|${this.accessKey}`
  }

  /** POST {baseUrl}/auth - access-key auth-method login. */
  private async authenticate(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey())
    if (cached && Date.now() - cached.cachedAt < TOKEN_CACHE_MS) {
      return cached.token
    }

    const res = await this.rawFetch(`${this.baseUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        'access-id': this.accessId,
        'access-key': this.accessKey,
        'access-type': 'access_key',
      }),
    })

    if (!res.ok) {
      throw new Error(
        `Akeyless authentication failed against ${this.baseUrl}: ${akeylessErrorMessage(res)}. ` +
          'Check the Access ID/Key and that the auth method is enabled.',
      )
    }

    const parsed = parseJson<{ token?: string }>(res.body)
    if (!parsed?.token) {
      throw new Error(`Akeyless authentication returned no token (HTTP ${res.status})`)
    }

    tokenCache.set(this.cacheKey(), { token: parsed.token, cachedAt: Date.now() })
    return parsed.token
  }

  /**
   * POST {baseUrl}{path} with `token` merged into the JSON body. Never
   * throws on an HTTP error status - callers inspect `status` so they can
   * tell a genuine 404/"not found" (object absent) from a real failure.
   * Retries once on 401 (expired/revoked token).
   */
  async request(path: string, body: Record<string, unknown> = {}): Promise<AkeylessResponse> {
    let token = await this.authenticate()
    let res = await this.send(path, token, body)

    if (res.status === 401) {
      tokenCache.delete(this.cacheKey())
      token = await this.authenticate()
      res = await this.send(path, token, body)
    }

    return res
  }

  private async send(path: string, token: string, body: Record<string, unknown>): Promise<AkeylessResponse> {
    return this.rawFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, token }),
    })
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<AkeylessResponse> {
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
 * Build an Akeyless client from a connection endpoint (optional Gateway
 * override), a credential (Access ID/Key) and app settings (timeout).
 * Returns a descriptive `error` instead of throwing so every handler can
 * surface one consistent message.
 */
export function buildAkeylessClient(
  endpoint: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: AkeylessClient; baseUrl: string } | { error: string } {
  const credentials = resolveAkeylessCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }

  const baseUrl = resolveAkeylessBaseUrl(endpoint)
  const resolved = readAkeylessSettings(settings)
  return {
    client: new AkeylessClient({ baseUrl, credentials, timeoutMs: resolved.timeoutMs }),
    baseUrl,
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

/** Extract a human-readable error from an Akeyless error response body (`{"error": "..."}`) . */
export function akeylessErrorMessage(res: AkeylessResponse): string {
  const parsed = parseJson<{ error?: string }>(res.body)
  if (parsed?.error) return parsed.error
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

/** Turn a checkbox/boolean canvas field into the "true"/"false" string most Akeyless write endpoints expect. */
export function boolFlag(value: unknown): string {
  return value === true || value === 'true' ? 'true' : 'false'
}

/** Turn a tags/multiselect canvas value into a clean, deduplicated string list. */
export function toStringList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return [...new Set(value.map((v) => String(v).trim()).filter((v) => v.length > 0))]
  if (typeof value === 'string') {
    return [
      ...new Set(
        value
          .split(/[,\n]/)
          .map((v) => v.trim())
          .filter((v) => v.length > 0),
      ),
    ]
  }
  return []
}

/** Build a request body with every `undefined`/empty-string/empty-array value stripped. */
export function compactBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.length === 0) continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

/** Order-insensitive set equality - used across drift-detect handlers comparing string-set fields. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}
