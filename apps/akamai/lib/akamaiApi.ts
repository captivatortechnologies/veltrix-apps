// =============================================================================
// Akamai access seam — EdgeGrid (EG1-HMAC-SHA256) request signing + REST client.
//
// Every Akamai OPEN API request carries an `Authorization: EG1-HMAC-SHA256 ...`
// header computed by signing a canonical request with the credential's
// client_secret. The signer below is a faithful port of Akamai's official
// EdgeGrid reference implementations (AkamaiOPEN-edgegrid-python / -ruby); the
// algorithm is fully specified, so this is deterministic and unit-tested against
// the canonical data-to-sign assembly (see lib/__tests__/akamaiApi.test.ts).
//
// EdgeGrid credentials come from an `.edgerc` and map onto a Veltrix credential:
//   host          → the connection endpoint / component hostname (base URL)
//   client_token  → credential.username
//   access_token  → credential.apiToken
//   client_secret → credential.password
//
// The base URL is `https://<host>`; Akamai APIs are always on 443 with a public
// CA certificate, so the global fetch transport is used (no self-signed handling).
// =============================================================================

import { createHmac, createHash, randomUUID } from 'node:crypto'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** Network Lists API v2 collection path. */
export const NETWORK_LISTS_PATH = '/network-list/v2/network-lists'

/** Akamai signs at most the first 128 KB of a POST body (the reference `max_body`). */
const MAX_SIGN_BODY_BYTES = 131072

// --- Credential mapping -------------------------------------------------------

export interface EdgeGridCredentials {
  clientToken: string
  clientSecret: string
  accessToken: string
}

export const MISSING_CREDENTIAL_MESSAGE =
  'Akamai EdgeGrid needs three values from your .edgerc: client_token (credential username), ' +
  'access_token (credential API token) and client_secret (credential password). Attach a ' +
  'credential carrying all three.'

/**
 * Extract the EdgeGrid client from a Veltrix credential. Convention:
 * client_token in `username`, access_token in `apiToken`, client_secret in
 * `password`. Returns null when any of the three is missing.
 */
export function resolveEdgeGridCredentials(credential: CredentialRef | null): EdgeGridCredentials | null {
  if (!credential) return null
  const clientToken = credential.username?.trim()
  const accessToken = credential.apiToken?.trim()
  const clientSecret = credential.password?.trim()
  if (!clientToken || !accessToken || !clientSecret) return null
  return { clientToken, clientSecret, accessToken }
}

/** Normalize a host (bare hostname or URL) into an `https://host` base URL. */
export function buildAkamaiBaseUrl(host: string): string {
  const h = host
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split('/')[0]
  return `https://${h}`
}

// --- EdgeGrid signing primitives ---------------------------------------------

/** base64( HMAC-SHA256(key, data) ) — both HMAC steps in the algorithm use this. */
function base64HmacSha256(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64')
}

/** base64( SHA256(data) ) — the POST content hash. */
function base64Sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('base64')
}

/**
 * EdgeGrid timestamp: `yyyyMMddTHH:mm:ss+0000` in UTC. Must be within ~30s of
 * real time or Akamai rejects the request.
 */
export function edgeGridTimestamp(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}+0000`
  )
}

/**
 * Content hash — base64(SHA256(body)), computed ONLY for POST requests with a
 * non-empty body (an Akamai quirk: PUT/DELETE bodies are never hashed). The body
 * is truncated to the first 128 KB before hashing, matching the reference signer.
 */
export function makeContentHash(method: string, body: string | undefined): string {
  if (method.toUpperCase() !== 'POST' || !body) return ''
  const bytes = Buffer.from(body, 'utf8')
  const clipped = bytes.length > MAX_SIGN_BODY_BYTES ? bytes.subarray(0, MAX_SIGN_BODY_BYTES) : bytes
  return base64Sha256(clipped)
}

/**
 * Canonicalize the headers to sign: `name:value` pairs joined with tabs, header
 * names lowercased, values trimmed with internal whitespace collapsed to a single
 * space. Akamai's Network Lists API signs no headers, so this is normally empty.
 */
export function canonicalizeHeaders(headers?: Record<string, string>): string {
  if (!headers) return ''
  return Object.keys(headers)
    .map((name) => `${name.toLowerCase()}:${headers[name].trim().replace(/\s+/g, ' ')}`)
    .join('\t')
}

export interface SignRequestParams {
  method: string
  /** The absolute request URL, exactly as sent (path + query included). */
  url: string
  credentials: EdgeGridCredentials
  timestamp: string
  nonce: string
  /** The request body, exactly as sent. Only hashed for POST. */
  body?: string
  /** Headers to sign — normally none for the Network Lists API. */
  headersToSign?: Record<string, string>
}

/**
 * Assemble the tab-separated data-to-sign string. Field order (7 fields, 6 tabs):
 *   method \t scheme \t host \t relativeUrl \t canonicalHeaders \t contentHash \t authData
 * where `authData` is the Authorization value WITHOUT the trailing `signature=...`.
 */
export function makeDataToSign(params: SignRequestParams, authData: string): string {
  const u = new URL(params.url)
  const relativeUrl = `${u.pathname}${u.search}`
  return [
    params.method.toUpperCase(),
    u.protocol.replace(/:$/, ''),
    u.host,
    relativeUrl,
    canonicalizeHeaders(params.headersToSign),
    makeContentHash(params.method, params.body),
    authData,
  ].join('\t')
}

/**
 * Compute the full `Authorization: EG1-HMAC-SHA256 ...` header value.
 *
 * Steps (per the EdgeGrid spec):
 *   authData    = "EG1-HMAC-SHA256 client_token=..;access_token=..;timestamp=..;nonce=..;"
 *   signingKey  = base64( HMAC-SHA256(client_secret, timestamp) )
 *   dataToSign  = <tab-separated canonical request> (authData is its last field)
 *   signature   = base64( HMAC-SHA256(signingKey, dataToSign) )   // signingKey is the base64 STRING
 *   Authorization = authData + "signature=" + signature
 */
export function makeAuthorizationHeader(params: SignRequestParams): string {
  const { clientToken, accessToken, clientSecret } = params.credentials
  const authData =
    `EG1-HMAC-SHA256 client_token=${clientToken};access_token=${accessToken};` +
    `timestamp=${params.timestamp};nonce=${params.nonce};`
  const signingKey = base64HmacSha256(clientSecret, params.timestamp)
  const dataToSign = makeDataToSign(params, authData)
  const signature = base64HmacSha256(signingKey, dataToSign)
  return `${authData}signature=${signature}`
}

// --- REST client --------------------------------------------------------------

export interface AkamaiResponse {
  status: number
  ok: boolean
  body: string
}

export type AkamaiMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * A thin EdgeGrid-signed REST client. Never throws on HTTP error statuses —
 * callers inspect `status` to distinguish 404/401/etc. Throws only on network
 * errors and timeout. Each request gets a fresh timestamp + nonce and is signed
 * over the exact URL and body sent.
 */
export class AkamaiClient {
  private readonly baseUrl: string
  private readonly credentials: EdgeGridCredentials
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: EdgeGridCredentials; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.credentials = opts.credentials
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: AkamaiMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<AkamaiResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const bodyStr = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const authorization = makeAuthorizationHeader({
      method,
      url: url.toString(),
      credentials: this.credentials,
      timestamp: edgeGridTimestamp(),
      nonce: randomUUID(),
      body: bodyStr,
    })

    const headers: Record<string, string> = { Authorization: authorization, Accept: 'application/json' }
    if (bodyStr !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), { method, headers, body: bodyStr, signal: controller.signal })
      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build an AkamaiClient from handler context pieces, or return the reason it
 * cannot be built. Deploy-family handlers all start with this.
 */
export function buildAkamaiClient(
  host: string,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: AkamaiClient; baseUrl: string } | { error: string } {
  const credentials = resolveEdgeGridCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }
  const baseUrl = buildAkamaiBaseUrl(host)
  return { client: new AkamaiClient({ baseUrl, credentials, timeoutMs: readTimeoutMs(settings) }), baseUrl }
}

/** Read the request timeout setting (seconds → ms), defaulting to 30s. */
export function readTimeoutMs(settings: Record<string, unknown>): number {
  const raw = settings.request_timeout_seconds
  const seconds = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 30
  return seconds * 1000
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}
