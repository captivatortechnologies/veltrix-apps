// =============================================================================
// Recorded Future API client (List API).
//
// Recorded Future exposes a SINGLE, cloud-hosted REST API at a FIXED base URL —
//   https://api.recordedfuture.com
// (a few customers use a regional / dedicated cloud, so the base is overridable
// via the `api_base_url` app setting or the connection endpoint). There is no
// per-tenant hostname the way an on-prem tool has.
//
// Auth is a single API token carried verbatim in the `X-RFToken` header on every
// request (NO Bearer prefix). The token is stored on the connection credential's
// `apiToken` (falling back to `password`).
//   Confirmed: https://docs.recordedfuture.com/reference/get-started
//
// The Recorded Future API is overwhelmingly READ (intelligence lookup / entity
// enrichment). The one genuinely WRITABLE configuration surface is the List API
// (Watch Lists / custom lists), rooted at `<base>/list`:
//   POST   /list/create                    { name, type }            → { id, ... }
//   POST   /list/search                    { name?, type?, limit? }  → [ ListInfo ]
//   GET    /list/{listId}/info                                       → ListInfo
//   GET    /list/{listId}/status                                     → { size, status }
//   GET    /list/{listId}/entities                                   → [ entity ]
//   POST   /list/{listId}/entity/add       { entity, context? }
//   DELETE /list/{listId}/entity/remove    { entity }
//   Confirmed: https://docs.recordedfuture.com/reference/lists-create (+ siblings)
//
// A second writable surface is the Fusion Files API, rooted at `<base>/fusion/v3`
// (same host + `X-RFToken`, but a raw-bytes contract, not JSON) — see `raw()`
// below and config-types/fusion-files/_shared.ts.
//   Confirmed: https://docs.recordedfuture.com/reference/fusion-files-upload (+ siblings)
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`/`json`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

/** The fixed, well-known Recorded Future API base URL. */
export const DEFAULT_RF_BASE_URL = 'https://api.recordedfuture.com'

/** All List API paths hang off this segment under the base URL. */
export const LIST_API_PREFIX = '/list'

export interface RecordedFutureSettings {
  timeoutMs: number
  baseUrl: string
}

/**
 * Resolve request settings from the app settings + an optional endpoint override.
 * `api_base_url` (setting) or a connection endpoint may point at a regional cloud;
 * otherwise the fixed default is used.
 */
export function readRecordedFutureSettings(
  settings: Record<string, unknown>,
  endpointOverride?: string | null,
): RecordedFutureSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs, baseUrl: normalizeBaseUrl(endpointOverride, settings.api_base_url) }
}

/**
 * Normalize a base URL from (in priority order) a connection endpoint override,
 * the `api_base_url` setting, then the fixed default. Accepts a bare host or a
 * full URL, forces https, and strips any path / trailing slash.
 */
export function normalizeBaseUrl(endpointOverride?: unknown, settingBase?: unknown): string {
  const candidate =
    firstNonEmpty(endpointOverride) ?? firstNonEmpty(settingBase) ?? DEFAULT_RF_BASE_URL
  let host = candidate.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim()
  if (!host) host = DEFAULT_RF_BASE_URL.replace(/^https?:\/\//i, '')
  return `https://${host}`
}

function firstNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Extract the Recorded Future API token from a Veltrix credential. */
export function resolveRecordedFutureToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Recorded Future API token — store your API token in the connection credential’s ' +
  '"API token" field. Request a token from the Recorded Future support portal ' +
  '(support.recordedfuture.com > Requesting API Tokens), scoped to the List API.'

/** A parsed Recorded Future API response. `json` is the parsed body (null when absent/invalid). */
export interface RecordedFutureResponse {
  status: number
  ok: boolean
  json: unknown
  body: string
}

/** A raw (non-JSON) Recorded Future API response — see `RecordedFutureClient.raw`. */
export interface RecordedFutureRawResponse {
  status: number
  ok: boolean
  body: string
  headers: Headers
}

export class RecordedFutureClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  private authHeaders(): Record<string, string> {
    return { 'X-RFToken': this.token, Accept: 'application/json' }
  }

  /** Low-level request against a List API `path` (e.g. `/list/create`). Never throws on non-2xx. */
  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<RecordedFutureResponse> {
    const headers: Record<string, string> = { ...this.authHeaders() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let json: unknown = null
      if (text) {
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
      }
      return { status: res.status, ok: res.status >= 200 && res.status < 300, json, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  get(path: string): Promise<RecordedFutureResponse> {
    return this.request('GET', path)
  }
  post(path: string, body: unknown): Promise<RecordedFutureResponse> {
    return this.request('POST', path, body)
  }
  delete(path: string, body?: unknown): Promise<RecordedFutureResponse> {
    return this.request('DELETE', path, body)
  }

  /**
   * Raw (non-JSON) request — for List API siblings whose contract isn't
   * `application/json` (the Fusion Files API sends/receives raw bytes and is
   * read via response headers like ETag). Same host/token/timeout as `request`;
   * never throws on a non-2xx status, and returns the response `Headers` so a
   * caller can read ETag / Last-Modified directly.
   */
  async raw(
    method: 'GET' | 'HEAD' | 'POST' | 'DELETE',
    path: string,
    opts: { body?: string; contentType?: string } = {},
  ): Promise<RecordedFutureRawResponse> {
    const headers: Record<string, string> = { ...this.authHeaders() }
    if (opts.body !== undefined) headers['Content-Type'] = opts.contentType ?? 'application/octet-stream'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body,
        signal: controller.signal,
      })
      const body = method === 'HEAD' ? '' : await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body, headers: res.headers }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Connectivity / health probe: search lists with a minimal limit. 200 = the
   * token is valid and has List API access; 401/403 = bad / unentitled token.
   * POST /list/search { limit: 1 }.
   */
  async health(): Promise<RecordedFutureResponse> {
    return this.post(`${LIST_API_PREFIX}/search`, { limit: 1 })
  }
}

/**
 * Build a client from the app settings + credential, with an optional endpoint
 * override (a regional cloud host). Returns `{ error }` when the token is missing.
 */
export function buildRecordedFutureClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
  endpointOverride?: string | null,
): { client: RecordedFutureClient; baseUrl: string } | { error: string } {
  const token = resolveRecordedFutureToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readRecordedFutureSettings(settings, endpointOverride)
  return {
    client: new RecordedFutureClient({ baseUrl: resolved.baseUrl, token, timeoutMs: resolved.timeoutMs }),
    baseUrl: resolved.baseUrl,
  }
}

/**
 * Human-readable message from a Recorded Future error response. RF wraps errors as
 * `{ error: { message } }` or `{ message }`; fall back to the raw body/status.
 * Never throws.
 */
export function recordedFutureErrorMessage(res: RecordedFutureResponse): string {
  const json = res.json as { error?: { message?: unknown }; message?: unknown } | null
  if (json && typeof json === 'object') {
    const nested = json.error && typeof json.error === 'object' ? json.error.message : undefined
    if (typeof nested === 'string' && nested) return nested
    if (typeof json.message === 'string' && json.message) return json.message
  }
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

/**
 * Inspect a write response and return an error message when RF rejected it, or
 * null on success. NON-UNION `string | null` (the platform handler loader cannot
 * narrow discriminated unions).
 */
export function recordedFutureWriteError(res: RecordedFutureResponse): string | null {
  if (!res.ok) return recordedFutureErrorMessage(res)
  return null
}
