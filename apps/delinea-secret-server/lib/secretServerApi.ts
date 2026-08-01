// =============================================================================
// Delinea Secret Server REST API client.
//
// One path: HTTPS REST against the Secret Server web/API tier. The operator
// supplies the Secret Server BASE URL as the connection endpoint:
//   on-prem : https://<host>/SecretServer
//   cloud   : https://<tenant>.secretservercloud.com
// The app then targets  <base>/api/v1/…  and authenticates at  <base>/oauth2/token.
//
// Auth is the OAuth2 *password grant*: POST form-encoded
//   grant_type=password & username=<u> & password=<p>
// to  <base>/oauth2/token  → { access_token, refresh_token, expires_in, token_type }.
// The access token is then sent as  Authorization: Bearer <token>  on every REST
// call. The token is obtained lazily on the first request and cached for the
// lifetime of the client (one handler invocation).
//
// On-prem Secret Server commonly ships a self-signed certificate, so the
// transport uses node:https with rejectUnauthorized driven by the `verify_tls`
// setting (default off → tolerate self-signed), the same posture as the misp /
// security-onion clients. Cloud presents a public certificate; enable verify_tls.
//
// NOTE: paths + response shapes (oauth2/token, /api/v1/folders, the paginated
// { records, total } list envelope) follow the documented Secret Server v1 REST
// API; verify against a live Secret Server instance.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_TIMEOUT_MS = 30_000

export interface SecretServerResponse {
  status: number
  ok: boolean
  body: string
}

export interface SecretServerCredentials {
  username: string
  password: string
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Secret Server credential — store the API user in the credential "username" field and its ' +
  'password in the "password" field. Use a dedicated service account whose permissions are scoped ' +
  'to the folders this app manages, and enable Webservices in Secret Server.'

/** Extract the API user's username + password from a Veltrix credential. */
export function resolveSecretServerCredentials(credential: CredentialRef | null): SecretServerCredentials | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  // Fall back to apiToken so a password stored in the token field still works.
  const password = (credential.password ?? credential.apiToken ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

/** Normalize a raw endpoint into an https base URL with no trailing slash. */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  return withScheme.replace(/\/+$/, '')
}

export interface SecretServerSettings {
  verifyTls: boolean
  timeoutMs: number
}

/** Read app settings, falling back to safe defaults (ctx.settings is {} in prod). */
export function readSecretServerSettings(settings: Record<string, unknown>): SecretServerSettings {
  const verifyTls = settings.verify_tls === true
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS
  return { verifyTls, timeoutMs }
}

export type SecretServerMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * One HTTPS request over node:https so the transport can tolerate a self-signed
 * certificate (rejectUnauthorized is caller-controlled). `url` is a full URL.
 */
function httpsRaw(
  url: string,
  init: {
    method?: SecretServerMethod
    headers?: Record<string, string>
    body?: string
    rejectUnauthorized: boolean
    timeoutMs: number
  },
): Promise<SecretServerResponse> {
  const u = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: init.rejectUnauthorized,
        timeout: init.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${init.timeoutMs / 1000}s connecting to ${u.host}`)))
    if (init.body) req.write(init.body)
    req.end()
  })
}

/** Build a full `<base>/api/v1<path>?<query>` URL. */
function buildApiUrl(baseUrl: string, apiPath: string, query?: Record<string, string | number | boolean | undefined>): string {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return `${baseUrl}/api/v1${apiPath}${qs ? `?${qs}` : ''}`
}

/**
 * Stateful Secret Server client. Owns one OAuth2 access token for its lifetime:
 * the first request triggers a token fetch (cached) and reuses it thereafter.
 * Never throws on an HTTP error status — callers inspect `status`/`ok`.
 */
export class SecretServerClient {
  private readonly baseUrl: string
  private readonly credentials: SecretServerCredentials
  private readonly verifyTls: boolean
  private readonly timeoutMs: number
  private token: string | null = null

  constructor(opts: { baseUrl: string; credentials: SecretServerCredentials; verifyTls: boolean; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.credentials = opts.credentials
    this.verifyTls = opts.verifyTls
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * Ensure an access token exists, running the OAuth2 password grant exactly
   * once. Returns a NON-UNION { ok, error } so the platform handler loader (which
   * does not narrow discriminated unions) never has to.
   */
  async ensureToken(): Promise<{ ok: boolean; error: string | null }> {
    if (this.token) return { ok: true, error: null }
    const form = new URLSearchParams({
      grant_type: 'password',
      username: this.credentials.username,
      password: this.credentials.password,
    }).toString()
    const res = await httpsRaw(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      rejectUnauthorized: this.verifyTls,
      timeoutMs: this.timeoutMs,
    })
    if (!res.ok) return { ok: false, error: secretServerErrorMessage(res) }
    const parsed = parseJson<{ access_token?: string }>(res.body)
    const token = parsed?.access_token
    if (!token) return { ok: false, error: 'Secret Server OAuth2 token endpoint returned no access_token' }
    this.token = token
    return { ok: true, error: null }
  }

  /** Authenticated request against `/api/v1<path>`. Fetches a token first if needed. */
  async request(
    method: SecretServerMethod,
    apiPath: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<SecretServerResponse> {
    const session = await this.ensureToken()
    if (!session.ok) return { status: 401, ok: false, body: JSON.stringify({ message: session.error }) }

    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` }
    // A body-less request must not advertise a JSON content-type — only set it with a body.
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

    return httpsRaw(buildApiUrl(this.baseUrl, apiPath, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      rejectUnauthorized: this.verifyTls,
      timeoutMs: this.timeoutMs,
    })
  }
}

/**
 * Build a client from a connection endpoint (the Secret Server base URL), a
 * credential and settings. Union return { client, ... } | { error } — handlers
 * branch on `'error' in built`, matching the platform's proven app pattern.
 */
export function buildSecretServerClient(
  endpoint: string | null | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: SecretServerClient; baseUrl: string; apiBase: string } | { error: string } {
  const creds = resolveSecretServerCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const baseUrl = normalizeBaseUrl(endpoint)
  if (!baseUrl) {
    return {
      error:
        'No Secret Server endpoint — set the base URL on the connection (on-prem ' +
        'https://<host>/SecretServer, cloud https://<tenant>.secretservercloud.com).',
    }
  }

  const { verifyTls, timeoutMs } = readSecretServerSettings(settings)
  return {
    client: new SecretServerClient({ baseUrl, credentials: creds, verifyTls, timeoutMs }),
    baseUrl,
    apiBase: `${baseUrl}/api/v1`,
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
 * Human-readable error from a Secret Server response. OAuth2 errors are
 * { error, error_description }; REST errors are { message, errorCode } (or a
 * modelState bag). Falls back to the raw body / status.
 */
export function secretServerErrorMessage(res: SecretServerResponse): string {
  const parsed = parseJson<{ error?: string; error_description?: string; message?: string; errorCode?: string }>(res.body)
  if (parsed?.error_description) {
    return parsed.error ? `${parsed.error_description} (${parsed.error})` : parsed.error_description
  }
  if (parsed?.error) return parsed.error
  if (parsed?.message) return parsed.errorCode ? `${parsed.message} (${parsed.errorCode})` : parsed.message
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}

// --- Shared list helpers ------------------------------------------------------
// Secret Server list endpoints return a paginated `{ records, total }` envelope
// (some return a bare array). These generic helpers are reused across config
// types (groups, secret-policies) so the envelope parsing + skip/take paging
// lives in exactly one place.

/** Normalize a checkbox / yes-no / 1-0 value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/** Parse a Secret Server list response — a `{ records, total }` envelope or a bare array. */
export function recordsFromResponse<T = Record<string, unknown>>(body: string): { records: T[]; total?: number } {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return { records: parsed as T[] }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { records?: unknown; total?: unknown }
    if (Array.isArray(obj.records)) {
      return { records: obj.records as T[], total: typeof obj.total === 'number' ? obj.total : undefined }
    }
  }
  return { records: [] }
}

/**
 * GET every page of a Secret Server list endpoint, concatenating `records`.
 * Pages via skip/take (take capped at 100 by the API). Throws on a non-OK
 * response. NOTE: the skip/take + `{ records, total }` envelope follows the
 * documented Secret Server v1 REST list convention; verify against a live
 * instance.
 */
export async function listAllRecords<T = Record<string, unknown>>(
  client: SecretServerClient,
  apiPath: string,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T[]> {
  const out: T[] = []
  const take = 100
  let skip = 0
  for (let page = 0; page < 100; page++) {
    const res = await client.request('GET', apiPath, { query: { ...query, take, skip } })
    if (!res.ok) throw new Error(`Failed to list ${apiPath}: ${secretServerErrorMessage(res)}`)
    const { records, total } = recordsFromResponse<T>(res.body)
    out.push(...records)
    skip += records.length
    if (records.length < take || (total !== undefined && skip >= total)) break
  }
  return out
}
