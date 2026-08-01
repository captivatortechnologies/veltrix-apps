// =============================================================================
// Cisco Umbrella API client.
//
// Umbrella exposes one REST surface at the fixed base URL https://api.umbrella.com.
// Authentication is OAuth2 client-credentials: POST /auth/v2/token with HTTP Basic
// auth (API key = username, API secret = password) and a form-encoded
// `grant_type=client_credentials` body returns a bearer token that lasts ~1 hour
// (expires_in seconds; no refresh token — re-POST to renew). Every subsequent API
// request carries `Authorization: Bearer <access_token>`.
//
// Convention for the Veltrix credential:
//   username -> Umbrella API key
//   apiToken -> Umbrella API secret  (preferred; falls back to password)
//
// Policies v2 responses use the envelope { status: { code, text }, data } for a
// single object and { status, meta: { page, limit, total }, data: [...] } for a
// collection; list endpoints page via the page/limit query params (default
// page 1, limit 100).
//
// NOTE: shapes follow the Umbrella API (Cloud Security) documentation. Verify
// against a live Umbrella tenant.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** Fixed Umbrella API base URL (no per-tenant host — SaaS). */
export const UMBRELLA_BASE_URL = 'https://api.umbrella.com'
/** OAuth2 client-credentials token endpoint. */
export const UMBRELLA_TOKEN_PATH = '/auth/v2/token'

const REQUEST_TIMEOUT_MS = 30_000
/** Refresh the token when less than this remains of its lifetime. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
/** Umbrella caps add/remove to 500 destinations per request. */
export const MAX_DESTINATIONS_PER_REQUEST = 500
/** Default page size for collection endpoints. */
export const PAGE_LIMIT = 100

export interface UmbrellaSettings {
  timeoutMs: number
}

export function readUmbrellaSettings(settings: Record<string, unknown>): UmbrellaSettings {
  const raw = settings.request_timeout_seconds
  const timeoutMs =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

export interface UmbrellaCredentials {
  apiKey: string
  apiSecret: string
}

/**
 * Extract the OAuth2 API client from a Veltrix credential.
 * Convention: API key in "username", API secret in "API token" (preferred) or
 * "password".
 */
export function resolveUmbrellaCredentials(credential: CredentialRef | null): UmbrellaCredentials | null {
  if (!credential) return null
  const apiKey = (credential.username ?? '').trim()
  const apiSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!apiKey || !apiSecret) return null
  return { apiKey, apiSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Cisco Umbrella credential — this app authenticates to the Umbrella API with an OAuth2 ' +
  'API key + secret. Store the API key in the credential "username" field and the API secret in the ' +
  '"API token" field (create an API key with the "Destination Lists" scope under Admin > API Keys in ' +
  'the Umbrella dashboard).'

export type UmbrellaMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface UmbrellaResponse {
  ok: boolean
  status: number
  body: string
}

/** The `{ status, meta, data }` envelope Umbrella wraps responses in. */
export interface UmbrellaEnvelope<T> {
  status?: { code?: number; text?: string }
  meta?: { page?: number; limit?: number; total?: number }
  data?: T
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Human-readable message from an Umbrella error response. */
export function umbrellaErrorMessage(res: UmbrellaResponse): string {
  const parsed = parseJson<{ message?: string; error?: string; status?: { text?: string } }>(res.body)
  const detail = parsed?.message || parsed?.error || parsed?.status?.text
  return detail ? `HTTP ${res.status}: ${detail}` : `Umbrella API returned HTTP ${res.status}`
}

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Tokens live ~1 hour; cache per key+secret so consecutive pipeline handlers
// (validate -> deploy -> healthCheck) reuse one token instead of re-authenticating.
// Keyed by key|secret so a rotated secret never reuses the old secret's token.
const tokenCache = new Map<string, CachedToken>()

export class UmbrellaClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly apiSecret: string
  private readonly timeoutMs: number

  constructor(opts: { credentials: UmbrellaCredentials; timeoutMs: number; baseUrl?: string }) {
    this.baseUrl = (opts.baseUrl ?? UMBRELLA_BASE_URL).replace(/\/+$/, '')
    this.apiKey = opts.credentials.apiKey
    this.apiSecret = opts.credentials.apiSecret
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.apiKey}|${this.apiSecret}`
  }

  /**
   * POST /auth/v2/token — HTTP Basic (key:secret) + form-encoded
   * grant_type=client_credentials. Returns a cached token while it is still
   * valid. Throws with a clear message on an auth failure.
   */
  private async authenticate(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey())
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken
    }

    const basic = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64')
    const res = await this.rawFetch(`${this.baseUrl}${UMBRELLA_TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    })

    if (res.status !== 200) {
      throw new Error(
        `Umbrella authentication failed: ${umbrellaErrorMessage(res)}. ` +
          'Check the API key and secret (Admin > API Keys in the Umbrella dashboard).',
      )
    }

    const parsed = parseJson<{ access_token?: string; expires_in?: number; token_type?: string }>(res.body)
    if (!parsed?.access_token) {
      throw new Error(`Umbrella authentication returned no access token (HTTP ${res.status})`)
    }

    const expiresInSeconds =
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 3600
    tokenCache.set(this.cacheKey(), {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    })
    return parsed.access_token
  }

  /**
   * Perform an Umbrella API request. Never throws on HTTP error statuses —
   * callers inspect `status` so they can distinguish 404 from a real failure.
   * Throws on network errors, timeout, and authentication failure. Retries once
   * on 401 (expired token) after re-authenticating.
   */
  async request(
    method: UmbrellaMethod,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<UmbrellaResponse> {
    let token = await this.authenticate()
    let res = await this.send(method, path, token, opts)

    if (res.status === 401) {
      tokenCache.delete(this.cacheKey())
      token = await this.authenticate()
      res = await this.send(method, path, token, opts)
    }
    return res
  }

  private async send(
    method: UmbrellaMethod,
    path: string,
    token: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown },
  ): Promise<UmbrellaResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const hasBody = opts.body !== undefined
    return this.rawFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    })
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<UmbrellaResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const body = await res.text()
      return { ok: res.status >= 200 && res.status < 300, status: res.status, body }
    } finally {
      clearTimeout(timer)
    }
  }

  // --- Typed helpers -----------------------------------------------------------

  get(path: string, query?: Record<string, string | number | undefined>): Promise<UmbrellaResponse> {
    return this.request('GET', path, { query })
  }
  post(path: string, body?: unknown): Promise<UmbrellaResponse> {
    return this.request('POST', path, { body })
  }
  patch(path: string, body?: unknown): Promise<UmbrellaResponse> {
    return this.request('PATCH', path, { body })
  }
  delete(path: string, body?: unknown): Promise<UmbrellaResponse> {
    return this.request('DELETE', path, { body })
  }

  /**
   * GET a paged collection following meta.total. Returns every row across pages
   * or the first failing response. Umbrella pages via page/limit (1-indexed).
   */
  async getAll<T>(
    path: string,
    maxPages = 100,
  ): Promise<{ ok: boolean; items: T[]; lastError?: UmbrellaResponse }> {
    const items: T[] = []
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.get(path, { page, limit: PAGE_LIMIT })
      if (!res.ok) return { ok: false, items, lastError: res }
      const env = parseJson<UmbrellaEnvelope<T[]>>(res.body)
      const rows = Array.isArray(env?.data) ? env!.data! : []
      items.push(...rows)
      const total = env?.meta?.total
      if (rows.length < PAGE_LIMIT || (typeof total === 'number' && items.length >= total)) break
    }
    return { ok: true, items }
  }
}

/**
 * Build an UmbrellaClient from a credential + settings, or return the reason it
 * cannot be built. Deploy-family handlers all start with this.
 */
export function buildUmbrellaClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: UmbrellaClient } | { error: string } {
  const credentials = resolveUmbrellaCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }
  const { timeoutMs } = readUmbrellaSettings(settings)
  return { client: new UmbrellaClient({ credentials, timeoutMs }) }
}
