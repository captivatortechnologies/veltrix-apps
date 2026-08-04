// =============================================================================
// Cortex XDR public API (v1) client.
//
// Palo Alto Networks Cortex XDR exposes a per-tenant REST API. The tenant's API
// FQDN is the connection endpoint / component hostname, e.g.
//   api-yourtenant.xdr.us.paloaltonetworks.com
//   api-yourtenant.xdr.eu.paloaltonetworks.com
// Requests go to `https://<fqdn>/public_api/v1/<path>`. Find the FQDN in the
// Cortex XDR console under Settings > Configurations > API Keys (the "Copy URL"
// on a generated key gives the exact base). VERIFY the region/FQDN against your
// live tenant.
//
// Auth (Standard security level) is two headers on every call:
//   x-xdr-auth-id: <API Key ID>   (the integer id of the key)
//   Authorization: <API Key>      (the key value, sent verbatim — NO Bearer)
// The API Key ID is stored on the credential's `username`; the API Key on its
// `apiToken` (falling back to `password`). Advanced security adds a per-request
// nonce + timestamp + SHA256 HMAC signature — see buildAdvancedAuthHeaders below
// for the (commented) seam; only Standard is wired up for v0.1.0.
//
// Every call is a POST whose JSON body wraps its parameters in `request_data`,
// and every response wraps its payload in `reply`:
//   request:  { "request_data": { ... } }
//   response: { "reply": ... }
// (A few bulk endpoints — notably indicators/insert_jsons — take `request_data`
//  as an ARRAY of objects rather than an object; callers pass the exact body.
//  VERIFY the exact envelope of each indicators endpoint against live Cortex XDR.)
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`/`json`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** All Cortex XDR public API paths hang off this prefix. */
export const API_BASE_PATH = '/public_api/v1'

export interface CortexXdrSettings {
  timeoutMs: number
}

export function readCortexXdrSettings(settings: Record<string, unknown>): CortexXdrSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

export interface CortexXdrCredentials {
  /** The API Key ID (integer id shown next to the key in the console). */
  apiKeyId: string
  /** The API Key value itself. */
  apiKey: string
}

/**
 * Extract the Cortex XDR API Key ID + API Key from a Veltrix credential. The key
 * id is the credential `username`; the key value is its `apiToken` (or `password`
 * for connections that stored the secret there).
 */
export function resolveCortexXdrCredentials(credential: CredentialRef | null): CortexXdrCredentials | null {
  if (!credential) return null
  const apiKeyId = (credential.username ?? '').trim()
  const apiKey = (credential.apiToken ?? credential.password ?? '').trim()
  if (!apiKeyId || !apiKey) return null
  return { apiKeyId, apiKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Cortex XDR credential — store the API Key ID in the credential "username" field and the API Key ' +
  'value in the "API Key" (token) field. Generate a Standard-security API key in the Cortex XDR ' +
  'console under Settings > Configurations > API Keys, scoped to what this app manages.'

export const MISSING_ENDPOINT_MESSAGE =
  'No Cortex XDR tenant API FQDN — register a connection whose endpoint is your tenant API host ' +
  '(e.g. api-yourtenant.xdr.us.paloaltonetworks.com). Find it under Settings > Configurations > ' +
  'API Keys > Copy URL in the Cortex XDR console.'

/** A parsed Cortex XDR API response. `reply` is the unwrapped `reply` payload (null when absent). */
export interface CortexXdrResponse {
  status: number
  ok: boolean
  json: unknown
  reply: unknown
  body: string
}

/** base64 without leaking Buffer typings into the app tsconfig. Reserved for the Advanced-auth seam. */
function base64(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
}

export class CortexXdrClient {
  private readonly baseUrl: string
  private readonly credentials: CortexXdrCredentials
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: CortexXdrCredentials; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.credentials = opts.credentials
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * Standard-security auth headers: the API Key ID + the API Key verbatim. This is
   * the auth level wired up for v0.1.0.
   */
  private standardAuthHeaders(): Record<string, string> {
    return {
      'x-xdr-auth-id': this.credentials.apiKeyId,
      Authorization: this.credentials.apiKey,
    }
  }

  /**
   * SEAM — Advanced-security auth (FOLLOW-UP, not used yet). Advanced keys require,
   * per request, a random nonce, the current UTC epoch-millis timestamp, and an
   * `Authorization` value of SHA256(apiKey + nonce + timestamp) sent as a hex
   * digest, with the nonce + timestamp echoed in `x-xdr-nonce` / `x-xdr-timestamp`.
   * Computing the digest needs node:crypto; wire this up (and let the connection
   * declare which security level the key uses) when Advanced auth is added.
   * VERIFY the exact string-to-sign + header names against live Cortex XDR.
   */
  // private advancedAuthHeaders(): Record<string, string> {
  //   const nonce = /* 64-char random string */ ''
  //   const timestamp = String(Date.now())
  //   const stringToSign = this.credentials.apiKey + nonce + timestamp
  //   const signature = /* sha256 hex of stringToSign, e.g. via node:crypto */ ''
  //   void base64 // (kept for a future base64-encoded variant)
  //   return {
  //     'x-xdr-auth-id': this.credentials.apiKeyId,
  //     'x-xdr-nonce': nonce,
  //     'x-xdr-timestamp': timestamp,
  //     Authorization: signature,
  //   }
  // }

  /**
   * POST a JSON body to a public-API `path` (e.g. `/indicators/insert_jsons/`) and
   * unwrap `reply`. `body` is the FULL request body (usually `{ request_data: … }`),
   * passed verbatim so bulk endpoints can send the array form. Never throws on a
   * non-2xx status — the caller inspects `status`/`ok`.
   */
  async post(path: string, body: unknown): Promise<CortexXdrResponse> {
    const headers: Record<string, string> = {
      ...this.standardAuthHeaders(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${API_BASE_PATH}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
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
      const reply =
        json && typeof json === 'object' && 'reply' in (json as Record<string, unknown>)
          ? (json as { reply: unknown }).reply
          : null
      return { status: res.status, ok: res.status >= 200 && res.status < 300, json, reply, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Convenience: POST with the standard `{ request_data }` object envelope. */
  async call(path: string, requestData: Record<string, unknown> = {}): Promise<CortexXdrResponse> {
    return this.post(path, { request_data: requestData })
  }

  /**
   * Connectivity / health probe: list endpoint groups with an empty request. 200 =
   * reachable + authenticated; 401/403 = bad key. VERIFY the path against live
   * Cortex XDR.
   */
  async health(): Promise<CortexXdrResponse> {
    return this.call('/endpoints/get_endpoint_groups/', {})
  }

  /**
   * SEAM — the newer "Cortex Platform" REST-verb APIs (external application
   * management, alert notification rules) live under `/platform/<area>/v1/...`
   * rather than the RPC-style `/public_api/v1/...` every other config type in
   * this app uses, and speak plain REST verbs (GET/POST/PUT/DELETE) with a bare
   * JSON body — no `{ request_data }` / `{ reply }` envelope. The published
   * OpenAPI fragments for these endpoints do not re-print the per-call auth
   * parameters the `/public_api/v1/*` fragments show explicitly, but the
   * Cortex Platform IAM docs describe a SINGLE API-key mechanism (scoped by the
   * RBAC permissions attached to the key) for the whole platform, not a second
   * credential type — so this reuses the same Standard-security headers.
   * VERIFY the exact auth requirement for `/platform/*` against a live tenant
   * before relying on write.
   */
  async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', fullPath: string, body?: unknown): Promise<CortexXdrResponse> {
    const headers: Record<string, string> = {
      ...this.standardAuthHeaders(),
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${fullPath}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
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
      // Platform REST endpoints return their payload directly (often under
      // `data`), not wrapped in `{ reply }` — expose the parsed body as `reply`
      // too so callers can use one shape regardless of API generation.
      return { status: res.status, ok: res.status >= 200 && res.status < 300, json, reply: json, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Normalize a tenant API FQDN into an `https://<host>` base (no scheme, path or
 * trailing slash on input). The `/public_api/v1` prefix is added per-request by
 * the client, so it is stripped here if the operator pasted the full URL.
 */
export function buildCortexBaseUrl(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
  if (!host) return null
  return `https://${host}`
}

/** Build a client from the tenant API FQDN, a credential and settings. */
export function buildCortexClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: CortexXdrClient; baseUrl: string } | { error: string } {
  const creds = resolveCortexXdrCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const baseUrl = buildCortexBaseUrl(hostname)
  if (!baseUrl) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readCortexXdrSettings(settings)
  return {
    client: new CortexXdrClient({ baseUrl, credentials: creds, timeoutMs: resolved.timeoutMs }),
    baseUrl,
  }
}

/**
 * Human-readable message from a Cortex XDR error response. Cortex wraps errors as
 * `{ reply: { err_code, err_msg, err_extra } }`; fall back to the raw body/status.
 * Never throws. VERIFY the error envelope shape against live Cortex XDR.
 */
export function cortexErrorMessage(res: CortexXdrResponse): string {
  const reply = res.reply as { err_msg?: unknown; err_extra?: unknown; err_code?: unknown } | null
  if (reply && typeof reply === 'object') {
    const msg = typeof reply.err_msg === 'string' ? reply.err_msg : ''
    const extra = typeof reply.err_extra === 'string' ? reply.err_extra : ''
    if (msg) return extra ? `${msg} — ${extra}` : msg
  }
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

/**
 * Inspect a write response and return an error message when Cortex rejected it, or
 * null on success. NON-UNION `string | null` (the platform handler loader cannot
 * narrow discriminated unions).
 */
export function cortexWriteError(res: CortexXdrResponse): string | null {
  if (!res.ok) return cortexErrorMessage(res)
  return null
}
