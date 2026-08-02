// =============================================================================
// Darktrace access seam.
//
// One path: HTTPS REST against a Darktrace master/appliance. Darktrace appliances
// commonly present a self-signed certificate, so the transport accepts untrusted
// certs (same posture as misp's mispApi) via node:https with rejectUnauthorized:false.
//
// Auth is Darktrace's DSA ("Darktrace Signed API") — a TWO-TOKEN scheme. Each
// request carries three headers derived from a public/private token pair:
//
//   DTAPI-Token:     <public token>                       (sent in the clear)
//   DTAPI-Date:      <YYYYMMDDTHHMMSS, UTC>                (compact ISO8601 basic)
//   DTAPI-Signature: HMAC-SHA1_hex(privateToken, S)       (S below)
//
//   S = "<request-uri incl. sorted query>\n<public token>\n<date>"
//
// The signing primitives (darktraceDate, stringToSign, signRequest, buildQuery)
// are isolated + pure so the exact assembly is unit-tested (see __tests__).
//
// FLAG — verify against a live Darktrace:
//   * HMAC algorithm is SHA1 (confirmed across public clients); some third-party
//     write-ups say SHA256 — DO NOT switch without a live check.
//   * DTAPI-Date is the compact basic form (20250115T143022), not dashed ISO.
//   * Query params MUST be alphabetically sorted in the signed string AND the wire
//     request — the SAME canonical string is used for both here.
//   * For POST the signature covers the request URI (path); the JSON body is not
//     part of the signed string on the clients we verified — confirm on newer builds.
// =============================================================================

import { createHmac } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_DARKTRACE_PORT = 443

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the Darktrace instance (443). Prefers an explicit URL. No trailing slash. */
export function buildDarktraceUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = component.port || DEFAULT_DARKTRACE_PORT
  const host = resolveHost(component, connectivity, provider)
  return `https://${host}${port === 443 ? '' : `:${port}`}`
}

// --- DSA signing primitives (pure — unit-tested) -----------------------------

/** The public/private token pair that drives DSA signing. */
export interface DarktraceAuth {
  publicToken: string
  privateToken: string
}

/**
 * The three DSA headers. Kept as a named type so the signer's output is explicit
 * and every request path merges the identical shape.
 */
export interface DtSignatureHeaders {
  'DTAPI-Token': string
  'DTAPI-Date': string
  'DTAPI-Signature': string
}

/**
 * Compact ISO8601 basic UTC timestamp, e.g. `20250115T143022`. This is the exact
 * form Darktrace's DSA expects for DTAPI-Date — NOT the dashed/colon extended form.
 */
export function darktraceDate(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  )
}

/** Assemble the DSA string-to-sign: `<request-uri>\n<public token>\n<date>`. */
export function stringToSign(requestUri: string, publicToken: string, date: string): string {
  return `${requestUri}\n${publicToken}\n${date}`
}

/**
 * Produce the three DSA headers for a request. `requestUri` is the path plus any
 * (already alphabetically-sorted) query string — the SAME string that hits the wire.
 */
export function signRequest(
  requestUri: string,
  auth: DarktraceAuth,
  date: string = darktraceDate(),
): DtSignatureHeaders {
  const signature = createHmac('sha1', auth.privateToken)
    .update(stringToSign(requestUri, auth.publicToken, date))
    .digest('hex')
  return {
    'DTAPI-Token': auth.publicToken,
    'DTAPI-Date': date,
    'DTAPI-Signature': signature,
  }
}

/**
 * Canonical query string: entries with an empty/undefined value dropped, keys
 * sorted alphabetically, each key+value percent-encoded. The identical string is
 * used to sign AND to request, so signatures always match the wire.
 */
export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

/** Join a path with a canonical query string (omits the `?` when empty). */
export function requestUri(path: string, query: string): string {
  return query ? `${path}?${query}` : path
}

/**
 * Derive the DSA token pair from a connection credential. The PUBLIC token is the
 * clear-text identifier (credential.username); the PRIVATE token is the HMAC secret
 * (credential.apiToken, falling back to password). Returns null when either is absent —
 * callers require a full pair before signing anything.
 */
export function darktraceAuthFrom(credential: CredentialRef | null | undefined): DarktraceAuth | null {
  if (!credential) return null
  const publicToken = (credential.username || '').trim()
  const privateToken = (credential.apiToken || credential.password || '').trim()
  if (!publicToken || !privateToken) return null
  return { publicToken, privateToken }
}

// --- HTTPS transport (self-signed tolerant) ----------------------------------

export interface DarktraceResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One signed HTTPS request that tolerates Darktrace's self-signed certificate.
 * `path` is the verbatim request URI (path + already-sorted query) — it is used
 * BOTH to sign and as the wire path, so the two never diverge. Only the base URL
 * is parsed for host/port; the path is never re-normalized.
 */
export function darktraceFetch(
  base: string,
  path: string,
  auth: DarktraceAuth,
  init: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<DarktraceResponse> {
  const u = new URL(base)
  const timeoutMs = init.timeoutMs ?? 15_000
  const signed = signRequest(path, auth)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...signed, ...(init.headers ?? {}) },
        rejectUnauthorized: false, // Darktrace appliances commonly ship self-signed certs
        timeout: timeoutMs,
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
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${u.host}`)))
    if (init.body) req.write(init.body)
    req.end()
  })
}

// --- JSON convenience helpers ------------------------------------------------

/** Signed GET with alphabetically-sorted query params → parsed JSON. */
export async function dtGetJson<T>(
  base: string,
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
  auth: DarktraceAuth,
  timeoutMs?: number,
): Promise<T> {
  const uri = requestUri(path, buildQuery(params))
  const res = await darktraceFetch(base, uri, auth, { method: 'GET', timeoutMs })
  if (!res.ok) throw new Error(`GET ${uri} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || 'null') as T
}

/**
 * Signed POST with a JSON body → parsed JSON. The signature covers the request URI
 * (path only); Darktrace's intelfeed write takes its parameters in the JSON body.
 */
export async function dtPostJson<T>(
  base: string,
  path: string,
  body: unknown,
  auth: DarktraceAuth,
  timeoutMs?: number,
): Promise<T> {
  const res = await darktraceFetch(base, path, auth, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
