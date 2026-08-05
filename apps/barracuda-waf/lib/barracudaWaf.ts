// =============================================================================
// Barracuda WAF-as-a-Service API client (v4).
//
// Auth is a login-token flow against the Barracuda Cloud Control account that
// owns the WAF-as-a-Service subscription:
//   POST https://api.waas.barracudanetworks.com/v4/waasapi/api_login/
//     { email, password, account_id? } -> { key, expiry }
// The returned `key` is sent on every subsequent call as the `auth-api` header
// (NOT `Authorization: Bearer`). `account_id` is optional and only needed for
// an MSP/partner account acting on behalf of a managed sub-account. Tokens are
// short-lived; this client caches the token on the instance and re-logs-in
// once it is within a minute of `expiry` (or on a 401, once).
//
// Refs: the live OpenAPI document served by the product itself at
// https://api.waas.barracudanetworks.com/v4/swagger/ (title "Barracuda
// WAF-as-a-Service API Documentation", version 4.0.0), specifically the
// "Account" (api_login/api_logout) and "App | *" tag groups; corroborated by
// documentation.campus.barracuda.com/wiki/display/WAFAAS/WaaS+API+Version+4
// ("Getting Started") and the public
// github.com/barracudanetworks/waf-automation waf-as-a-service-api sample.
//
// Every per-application resource hangs off /applications/{appName}/... where
// `appName` is the WAF-as-a-Service Application's own name (not a numeric
// id) — this app resolves it from the registered component's `hostname`,
// the same convention this codebase uses for Cloudflare zones.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status — callers inspect `status`/`ok`.
// List endpoints follow the account's Django REST Framework pagination
// (`{count, next, previous, results}`) when a collection is large enough to
// paginate; `listAll` follows `next` to completion.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const DEFAULT_BASE_URL = 'https://api.waas.barracudanetworks.com/v4/waasapi'
const REQUEST_TIMEOUT_MS = 30_000
const TOKEN_SKEW_MS = 60_000
const DEFAULT_TOKEN_TTL_MS = 25 * 60_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 2_000
const MAX_PAGES = 200

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Settings / credential resolution ---------------------------------------

export interface BarracudaSettings {
  baseUrl: string
  timeoutMs: number
  /** MSP/partner account acting on behalf of a managed sub-account (api_login `account_id`). */
  accountId: string | null
}

export function readBarracudaSettings(settings: Record<string, unknown>): BarracudaSettings {
  const rawBase = settings.base_url
  let baseUrl = DEFAULT_BASE_URL
  if (typeof rawBase === 'string' && rawBase.trim()) {
    const b = rawBase.trim().replace(/\/+$/, '')
    baseUrl = /^https?:\/\//i.test(b) ? b : `https://${b}`
  }

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  const rawAccount = settings.account_id
  const accountId = typeof rawAccount === 'string' && rawAccount.trim() ? rawAccount.trim() : null

  return { baseUrl, timeoutMs, accountId }
}

export interface BarracudaCredential {
  email: string
  password: string
}

/** Extract the Barracuda Cloud Control admin email/password from a Veltrix credential. */
export function resolveBarracudaCredential(credential: CredentialRef | null): BarracudaCredential | null {
  if (!credential) return null
  const email = (credential.username ?? '').trim()
  const password = (credential.password ?? '').trim()
  if (!email || !password) return null
  return { email, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Barracuda Cloud Control credential — store the admin account email in the credential ' +
  '"Username" field and its password in "Password". These authenticate against ' +
  'POST /api_login/ to obtain the API session token (sent as the auth-api header on every call).'

export const MISSING_APP_NAME_MESSAGE =
  'No Barracuda WAF-as-a-Service Application name — register a component whose hostname is the ' +
  'exact Application name shown under Applications in the WAF-as-a-Service console (the value the ' +
  'API addresses as /applications/{appName}/...).'

// --- HTTP plumbing -----------------------------------------------------------

export interface BarracudaResponse {
  status: number
  ok: boolean
  body: string
}

export type BarracudaMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/**
 * Barracuda's list endpoints return either a bare array or the account's
 * Django REST Framework pagination envelope `{count, next, previous,
 * results}`. Normalize either shape to a plain array.
 */
export function asArray<T>(body: string): T[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj.results)) return obj.results as T[]
    if (Array.isArray(obj.data)) return obj.data as T[]
  }
  return []
}

/** Parse a single-resource body into a plain object, or {} when unrecognized. */
export function asObject(body: string): Record<string, unknown> {
  const parsed = parseJson<unknown>(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

/**
 * Extract a human-readable error from a Barracuda WaaS error body. DRF-style
 * errors are either `{"detail": "..."}` or a map of field name -> array of
 * messages (`{"name": ["This field is required."]}`) — this flattens either.
 */
export function barracudaErrorMessage(res: BarracudaResponse): string {
  const parsed = parseJson<Record<string, unknown>>(res.body)
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) return parsed.detail
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message
    const fieldErrors: string[] = []
    for (const [field, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        const msgs = value.filter((v) => typeof v === 'string')
        if (msgs.length) fieldErrors.push(`${field}: ${msgs.join(', ')}`)
      } else if (typeof value === 'string') {
        fieldErrors.push(`${field}: ${value}`)
      }
    }
    if (fieldErrors.length) return fieldErrors.join('; ')
  }
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}

/** Classify a thrown fetch/network error into a friendly message. */
export function classifyNetworkError(err: unknown, target: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Barracuda WAF-as-a-Service at ${target}.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${target}.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${target}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${target}: ${msg}`
  return `Could not reach Barracuda WAF-as-a-Service (${target}): ${msg}`
}

/**
 * Parse the api_login `expiry` value into an epoch-ms timestamp. The
 * documented shape is a timestamp string; this accepts an ISO date string, an
 * epoch in seconds, or an epoch in milliseconds, and falls back to a
 * conservative default TTL when the value can't be parsed (never trust a
 * token forever).
 */
export function parseTokenExpiry(expiry: unknown): number {
  if (typeof expiry === 'number' && Number.isFinite(expiry)) {
    // Heuristic: a 13-digit number is already epoch-ms, a 10-digit one is epoch-seconds.
    return expiry > 1e12 ? expiry : expiry * 1000
  }
  if (typeof expiry === 'string' && expiry.trim()) {
    const asNumber = Number(expiry)
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber > 1e12 ? asNumber : asNumber * 1000
    const parsed = Date.parse(expiry)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now() + DEFAULT_TOKEN_TTL_MS
}

export class BarracudaWaasClient {
  private readonly baseUrl: string
  private readonly cred: BarracudaCredential
  private readonly accountId: string | null
  private readonly timeoutMs: number
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(opts: { baseUrl: string; cred: BarracudaCredential; accountId: string | null; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.cred = opts.cred
    this.accountId = opts.accountId
    this.timeoutMs = opts.timeoutMs
  }

  private async login(): Promise<{ token?: string; error?: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const body: Record<string, unknown> = { email: this.cred.email, password: this.cred.password }
      if (this.accountId) body.account_id = this.accountId
      const res = await fetch(`${this.baseUrl}/api_login/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        return { error: barracudaErrorMessage({ status: res.status, ok: false, body: text }) }
      }
      const parsed = parseJson<{ key?: string; expiry?: unknown }>(text)
      if (!parsed?.key) return { error: 'api_login response did not include a "key"' }
      this.token = parsed.key
      this.tokenExpiresAt = parseTokenExpiry(parsed.expiry)
      return { token: this.token }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'api_login request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  private async ensureToken(): Promise<{ token?: string; error?: string }> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) return { token: this.token }
    return this.login()
  }

  /** Path prefix for one Application's resources: `/applications/{appName}`. */
  appPath(appName: string): string {
    return `/applications/${encodeURIComponent(appName)}`
  }

  async request(
    method: BarracudaMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<BarracudaResponse> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) return { status: 0, ok: false, body: auth.error ?? 'authentication failed' }

    let res = await this.send(method, path, opts, auth.token)
    // A 401 mid-session (token revoked/expired early) gets exactly one retry
    // after a forced re-login.
    if (res.status === 401) {
      this.token = null
      const reAuth = await this.ensureToken()
      if (reAuth.token) res = await this.send(method, path, opts, reAuth.token)
    }
    let attempts = 0
    while (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS)
      const retryAuth = await this.ensureToken()
      if (!retryAuth.token) break
      res = await this.send(method, path, opts, retryAuth.token)
      attempts++
    }
    return res
  }

  private async send(
    method: BarracudaMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
    token: string,
  ): Promise<BarracudaResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = { 'auth-api': token, Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

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
    } catch (err) {
      return { status: 0, ok: false, body: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * GET every page of a collection (following DRF `next`) and concatenate the
   * results. Bounded by MAX_PAGES as a runaway-pagination guard.
   */
  async listAll<T = unknown>(path: string): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    let items: T[] = []
    let next: string | null = path
    let pages = 0
    let lastStatus = 200
    let lastBody = ''
    while (next && pages < MAX_PAGES) {
      const isFullUrl = /^https?:\/\//i.test(next)
      const res: BarracudaResponse = isFullUrl
        ? await this.requestAbsolute('GET', next)
        : await this.request('GET', next)
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      items = items.concat(asArray<T>(res.body))
      const parsed: { next?: string | null } | null = parseJson(res.body)
      next = typeof parsed?.next === 'string' && parsed.next ? parsed.next : null
      pages++
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  /** Like `request`, but `path` is already an absolute URL (a DRF `next` link). */
  private async requestAbsolute(method: BarracudaMethod, absoluteUrl: string): Promise<BarracudaResponse> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) return { status: 0, ok: false, body: auth.error ?? 'authentication failed' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(absoluteUrl, {
        method,
        headers: { 'auth-api': auth.token, Accept: 'application/json' },
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } catch (err) {
      return { status: 0, ok: false, body: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build a client from the connection's endpoint/component hostname, a
 * credential and settings. Non-union: returns either `{ client, ... }` or
 * `{ error }`. `hostname` is the registered component's hostname, which this
 * app's convention treats as the exact Barracuda WAF-as-a-Service Application
 * name (see `appPath`).
 */
export function buildBarracudaClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: BarracudaWaasClient; baseUrl: string; appName: string } | { error: string } {
  const cred = resolveBarracudaCredential(credential)
  if (!cred) return { error: MISSING_CREDENTIAL_MESSAGE }

  const appName = (hostname ?? '').trim()
  if (!appName) return { error: MISSING_APP_NAME_MESSAGE }

  const resolved = readBarracudaSettings(settings)
  return {
    client: new BarracudaWaasClient({ baseUrl: resolved.baseUrl, cred, accountId: resolved.accountId, timeoutMs: resolved.timeoutMs }),
    baseUrl: resolved.baseUrl,
    appName,
  }
}

// --- Shared field readers (used across config-type validate.ts modules) -----

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/** A `tags` canvas field's value, normalized to a trimmed, de-duplicated string array. */
export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** Parse a `textarea` JSON-array escape-hatch field (see aqua-security's convention). Never throws. */
export function readJsonArray<T = unknown>(value: unknown): { items: T[]; error: string | null } {
  const raw = readString(value)
  if (!raw) return { items: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { items: [], error: `not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) return { items: [], error: 'must be a JSON array' }
  return { items: parsed as T[], error: null }
}
