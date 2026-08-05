// =============================================================================
// Mimecast API 2.0 client.
//
// Auth is OAuth2 client-credentials:
//   POST https://api.services.mimecast.com/oauth/token
//   grant_type=client_credentials, client_id, client_secret -> Bearer token
// The token is short-lived (~30 min, read expires_in); the client re-acquires it
// on expiry. Every request body is wrapped in { data: [ payload ] } and every
// response is { meta, data, fail } — HTTP 200 with a non-empty `fail` array is a
// logical failure, so callers must inspect `fail`.
//
// Convention for the Veltrix credential:
//   username -> client_id
//   password -> client_secret
//   base_url -> the `base_url` app setting (default https://api.services.mimecast.com)
//
// Rate limiting is HTTP 429 with X-RateLimit-Reset (milliseconds); this retries
// once after that reset.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_BASE_URL = 'https://api.services.mimecast.com'
const TOKEN_SKEW_MS = 60_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000

export interface MimecastSettings {
  timeoutMs: number
  baseUrl: string
}

export function readMimecastSettings(settings: Record<string, unknown>): MimecastSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawBase = settings.base_url
  let baseUrl = DEFAULT_BASE_URL
  if (typeof rawBase === 'string' && rawBase.trim()) {
    const b = rawBase.trim().replace(/\/+$/, '')
    baseUrl = /^https?:\/\//.test(b) ? b : `https://${b}`
  }
  return { timeoutMs, baseUrl }
}

export interface MimecastCredential {
  baseUrl: string
  clientId: string
  clientSecret: string
}

export function resolveMimecastCredential(credential: CredentialRef | null, settings: MimecastSettings): MimecastCredential | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { baseUrl: settings.baseUrl, clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Mimecast credential — this app authenticates to the Mimecast API 2.0 with OAuth2 client ' +
  'credentials. Store the Client ID in the credential "username" field and the Client Secret in ' +
  '"password". Register an API 2.0 application in the Mimecast Admin Console with a role granting the ' +
  'endpoints this app uses (e.g. Services | URL Protection | Edit).'

export interface MimecastResponse {
  status: number
  /** HTTP 2xx AND no logical failures. */
  ok: boolean
  data: unknown[]
  fail: Array<{ errors?: Array<{ code?: string; message?: string }> }>
  transportError?: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class MimecastClient {
  private readonly cred: MimecastCredential
  private readonly timeoutMs: number
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(opts: { cred: MimecastCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  private async ensureToken(): Promise<{ token?: string; error?: string }> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) return { token: this.token }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cred.clientId, client_secret: this.cred.clientSecret })
      const res = await fetch(`${this.cred.baseUrl}/oauth/token`, {
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
      this.tokenExpiresAt = Date.now() + (parsed.expires_in ?? 1799) * 1000
      return { token: this.token }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'token request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** POST an endpoint with a single payload (wrapped in { data: [payload] }). */
  async request(path: string, payload: Record<string, unknown> = {}): Promise<MimecastResponse> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) return { status: 0, ok: false, data: [], fail: [], transportError: auth.error }

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(`${this.cred.baseUrl}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ data: [payload] }),
          signal: controller.signal,
        })
        const text = await res.text()
        if (res.status === 429 && attempt === 0) {
          const reset = Number(res.headers.get('X-RateLimit-Reset'))
          await sleep(Number.isFinite(reset) && reset > 0 ? Math.min(reset, MAX_RATE_LIMIT_WAIT_MS) : 1000)
          continue
        }
        const parsed = parseJson<{ data?: unknown[]; fail?: MimecastResponse['fail'] }>(text)
        const fail = parsed?.fail ?? []
        return { status: res.status, ok: res.ok && fail.length === 0, data: parsed?.data ?? [], fail }
      } catch (err) {
        if (attempt === 0) continue
        return { status: 0, ok: false, data: [], fail: [], transportError: err instanceof Error ? err.message : 'request error' }
      } finally {
        clearTimeout(timer)
      }
    }
    return { status: 0, ok: false, data: [], fail: [], transportError: 'request failed' }
  }

  /** Call the newer /policy-management/cloud-gateway/v1/* REST surface (real HTTP methods, bare JSON). */
  async requestV1<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string | number | boolean>; body?: unknown } = {}
  ): Promise<MimecastV1Response<T>> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) return { status: 0, ok: false, body: null, error: auth.error }

    const qs = opts.query
      ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString()}`
      : ''

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(`${this.cred.baseUrl}${path}${qs}`, {
          method,
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        })
        const text = await res.text()
        if (res.status === 429 && attempt === 0) {
          const reset = Number(res.headers.get('X-RateLimit-Reset'))
          await sleep(Number.isFinite(reset) && reset > 0 ? Math.min(reset, MAX_RATE_LIMIT_WAIT_MS) : 1000)
          continue
        }
        const body = text ? parseJson<T>(text) : null
        return { status: res.status, ok: res.ok, body, error: res.ok ? undefined : v1ErrorMessage(body, res.status) }
      } catch (err) {
        if (attempt === 0) continue
        return { status: 0, ok: false, body: null, error: err instanceof Error ? err.message : 'request error' }
      } finally {
        clearTimeout(timer)
      }
    }
    return { status: 0, ok: false, body: null, error: 'request failed' }
  }
}

export function buildMimecastClient(cred: MimecastCredential, settings: MimecastSettings): MimecastClient {
  return new MimecastClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function mimecastErrorMessage(res: MimecastResponse): string {
  if (res.transportError) return res.transportError
  const errs = res.fail.flatMap((f) => f.errors ?? []).map((e) => e.message || e.code).filter(Boolean)
  if (errs.length) return errs.join('; ')
  return `Mimecast request failed (HTTP ${res.status})`
}

// =============================================================================
// Mimecast Policy Management v1 (developer.services.mimecast.com/docs/
// policymanagement/1) — a distinct, fully-RESTful surface at
// /policy-management/cloud-gateway/v1/*, separate from the legacy /api/policy/*
// form endpoints above. Real HTTP methods (GET with query params, POST/PATCH/
// DELETE with a bare JSON body — no {data:[...]} wrapper), and crucially every
// {id} sub-resource supports PATCH, so a changed policy/definition can be
// updated in place instead of deleted and recreated. List responses are always
// shaped `{ definitions: [...] }` regardless of the resource's own name (e.g.
// the anti-spoofing *policies* list still wraps in a `definitions` array — this
// is Mimecast's own generic list envelope, not a naming mistake here).
// It shares the same OAuth2 bearer token as the legacy surface, so callers
// reuse the same MimecastClient instance.
// =============================================================================

export interface MimecastV1Response<T = unknown> {
  status: number
  ok: boolean
  body: T | null
  error?: string
}

/** Read the `definitions` array out of a v1 list response (or a bare array). */
export function extractV1List<T = unknown>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[]
  const wrapped = body as { definitions?: T[] } | null
  return Array.isArray(wrapped?.definitions) ? (wrapped!.definitions as T[]) : []
}

export function v1ErrorMessage(body: unknown, status: number): string {
  const b = body as
    | { message?: string; error?: string; failures?: Array<{ message?: string }>; errors?: Array<{ message?: string } | string> }
    | null
  if (b?.message) return b.message
  if (b?.error) return b.error
  if (Array.isArray(b?.failures) && b.failures.length) {
    const msg = b.failures.map((f) => f?.message).filter(Boolean).join('; ')
    if (msg) return msg
  }
  if (Array.isArray(b?.errors) && b.errors.length) {
    const msg = b.errors.map((e) => (typeof e === 'string' ? e : e?.message)).filter(Boolean).join('; ')
    if (msg) return msg
  }
  return `Mimecast API error (HTTP ${status})`
}
