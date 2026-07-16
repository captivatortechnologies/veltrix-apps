// =============================================================================
// CyberArk Privileged Access Manager (PVWA) REST API client — Gen2.
//
// The PVWA REST API lives on the self-hosted PVWA web server:
//   https://<pvwa-host>/PasswordVault/API/
// Auth is a two-step *logon flow* (there is no static API key):
//   1. POST /PasswordVault/API/auth/{method}/Logon  (method ∈ CyberArk|LDAP|RADIUS)
//      body { username, password, concurrentSession: true }
//      → the response body is a BARE JSON STRING: the session token.
//   2. Send that token as the RAW `Authorization: <token>` header (NO "Bearer"
//      prefix) on every subsequent call.
//   3. POST /PasswordVault/API/auth/Logoff  releases the session.
//
// This client performs the Logon lazily on the first request, caches the token,
// and reuses it for the rest of the handler invocation. Collection endpoints
// return { value: [...], count, nextLink }; pagination is offset/limit.
//
// PVWA commonly ships a self-signed certificate; this client always uses HTTPS
// and never disables TLS verification (handlers may not import a custom
// dispatcher) — the platform host must trust the PVWA certificate.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const PAGE_LIMIT = 1000
const MAX_PAGES = 200

/** Supported logon methods. Default is CyberArk (the manager's Vault password). */
export const AUTH_METHODS = ['CyberArk', 'LDAP', 'RADIUS'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]

export interface CyberArkSettings {
  authMethod: AuthMethod
  timeoutMs: number
}

/** Read app settings, falling back to safe defaults (ctx.settings is {} in prod). */
export function readCyberArkSettings(settings: Record<string, unknown>): CyberArkSettings {
  const rawMethod = settings.auth_method
  const authMethod = AUTH_METHODS.includes(rawMethod as AuthMethod) ? (rawMethod as AuthMethod) : 'CyberArk'

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { authMethod, timeoutMs }
}

export interface CyberArkCredentials {
  username: string
  password: string
}

/** Extract the PVWA manager username + password from a Veltrix credential. */
export function resolveCyberArkCredentials(credential: CredentialRef | null): CyberArkCredentials | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  // The logon password is the manager account's Vault/LDAP/RADIUS password.
  const password = (credential.password ?? credential.apiToken ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No CyberArk PVWA credential — store the manager account username in the credential "username" ' +
  'field and its password in the "password" field. Use a dedicated service account whose Vault ' +
  'authorizations are scoped to the safes/accounts this app manages.'

export type CyberArkMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface CyberArkResponse {
  status: number
  ok: boolean
  body: string
}

/** Gen2 collection envelope. */
export interface CyberArkCollection<T = unknown> {
  value?: T[]
  count?: number
  nextLink?: string
}

/**
 * Stateful PVWA client. Owns one session token for its lifetime: the first
 * request triggers a Logon (cached), and `logoff()` releases it best-effort.
 */
export class CyberArkClient {
  private readonly baseUrl: string
  private readonly credentials: CyberArkCredentials
  private readonly authMethod: AuthMethod
  private readonly timeoutMs: number
  private token: string | null = null

  constructor(opts: {
    baseUrl: string
    credentials: CyberArkCredentials
    authMethod: AuthMethod
    timeoutMs: number
  }) {
    this.baseUrl = opts.baseUrl
    this.credentials = opts.credentials
    this.authMethod = opts.authMethod
    this.timeoutMs = opts.timeoutMs
  }

  /** Low-level fetch with an abort timeout. `auth` toggles the session header. */
  private async fetchRaw(
    method: CyberArkMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; auth: boolean },
  ): Promise<CyberArkResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    // A body-less request must not advertise a JSON content-type, or PVWA (like
    // Fastify) can reject it — only set it when there is a body.
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    // Raw session token — NO "Bearer" prefix (classic PVWA session token).
    if (opts.auth && this.token) headers.Authorization = this.token

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Ensure a session token exists, performing the Logon exactly once. Returns a
   * NON-UNION { ok, error } so the platform handler loader (which does not narrow
   * discriminated unions) never has to.
   */
  async ensureSession(): Promise<{ ok: boolean; error: string | null }> {
    if (this.token) return { ok: true, error: null }
    const res = await this.fetchRaw('POST', `/auth/${this.authMethod}/Logon`, {
      auth: false,
      body: {
        username: this.credentials.username,
        password: this.credentials.password,
        concurrentSession: true,
      },
    })
    if (!res.ok) {
      return { ok: false, error: cyberArkErrorMessage(res) }
    }
    const token = parseLogonToken(res.body)
    if (!token) {
      return { ok: false, error: 'PVWA Logon succeeded but returned no session token' }
    }
    this.token = token
    return { ok: true, error: null }
  }

  /** Authenticated request. Logs on first if needed; never throws on HTTP status. */
  async request(
    method: CyberArkMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<CyberArkResponse> {
    const session = await this.ensureSession()
    if (!session.ok) {
      return { status: 401, ok: false, body: JSON.stringify({ ErrorMessage: session.error }) }
    }
    return this.fetchRaw(method, path, { query: opts.query, body: opts.body, auth: true })
  }

  /**
   * GET every page of a Gen2 collection, concatenating `value`. Pages via
   * offset/limit until the reported `count` is reached or a short page returns.
   */
  async getAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let offset = 0
    let lastStatus = 0
    let lastBody = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request('GET', path, { query: { ...query, limit: PAGE_LIMIT, offset } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const parsed = parseJson<CyberArkCollection<T>>(res.body)
      const value = parsed?.value
      if (Array.isArray(value)) items.push(...value)
      const returned = Array.isArray(value) ? value.length : 0
      const total = parsed?.count
      offset += returned
      if (returned === 0 || returned < PAGE_LIMIT || (typeof total === 'number' && offset >= total)) break
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  /** Release the session. Best-effort: swallows any error (never throws). */
  async logoff(): Promise<void> {
    if (!this.token) return
    try {
      await this.fetchRaw('POST', '/auth/Logoff', { auth: true })
    } catch {
      // Ignore — the session will time out on its own.
    } finally {
      this.token = null
    }
  }
}

/**
 * Build a client from a component hostname (the PVWA host), a credential and
 * settings. Union return { client, ... } | { error } — handlers branch on
 * `'error' in built`, matching the platform's proven app pattern.
 */
export function buildCyberArkClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: CyberArkClient; baseUrl: string; pvwaUrl: string } | { error: string } {
  const creds = resolveCyberArkCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  let host = (hostname ?? '').trim()
  if (!host) {
    return {
      error:
        'No CyberArk PVWA host — register a component whose hostname is the PVWA web server ' +
        '(e.g. pvwa.example.com). The app targets https://<host>/PasswordVault/API.',
    }
  }
  // Accept a bare host, host:port, or a full URL and normalise to host[:port].
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')

  const resolved = readCyberArkSettings(settings)
  const pvwaUrl = `https://${host}/PasswordVault`
  const baseUrl = `${pvwaUrl}/API`

  return {
    client: new CyberArkClient({
      baseUrl,
      credentials: creds,
      authMethod: resolved.authMethod,
      timeoutMs: resolved.timeoutMs,
    }),
    baseUrl,
    pvwaUrl,
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
 * Parse the Logon response, which is a bare JSON string (the token in quotes).
 * Tolerates a raw unquoted token too. Returns the trimmed token or null.
 */
export function parseLogonToken(body: string): string | null {
  const text = (body ?? '').trim()
  if (!text) return null
  const parsed = parseJson<unknown>(text)
  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
  // Fallback: some proxies strip the quotes — accept a non-JSON opaque token.
  if (parsed === null && !/^[[{]/.test(text)) return text
  return null
}

/** Extract a human-readable error from a PVWA error response ({ErrorCode,ErrorMessage}). */
export function cyberArkErrorMessage(res: CyberArkResponse): string {
  const parsed = parseJson<{ ErrorCode?: string; ErrorMessage?: string; message?: string }>(res.body)
  if (parsed?.ErrorMessage) {
    return parsed.ErrorCode ? `${parsed.ErrorMessage} (${parsed.ErrorCode})` : parsed.ErrorMessage
  }
  if (parsed?.message) return parsed.message
  return res.body || `HTTP ${res.status}`
}

// --- NON-UNION parse/conditional helpers -------------------------------------
// Both fields are ALWAYS present so the platform handler loader never needs to
// narrow a discriminated union (which it cannot do — see veltrix-app-authoring).

export interface JsonObjectResult {
  value: Record<string, unknown> | null
  error: string | null
}

/** Parse a JSON-object field. Empty string → {}. */
export function parseJsonObject(raw: string | undefined): JsonObjectResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

export interface IntResult {
  value: number | null
  error: string | null
}

/** Parse a positive-integer field. Empty string → { value: null, error: null }. */
export function parsePositiveInt(raw: unknown): IntResult {
  if (raw === undefined || raw === null || raw === '') return { value: null, error: null }
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { value: null, error: 'must be a whole number' }
  if (n <= 0) return { value: null, error: 'must be greater than zero' }
  return { value: n, error: null }
}

/** URL-safe safe identifier. safeUrlId usually equals the encoded safe name. */
export function encodeSafeUrlId(safeUrlIdOrName: string): string {
  return encodeURIComponent(safeUrlIdOrName)
}
