// =============================================================================
// Graylog access seam.
//
// One path: REST against the Graylog REST API. The base path is `<host>/api/`.
// Graylog authenticates with HTTP Basic — two equivalent forms:
//   • a user:  `<username>:<password>`
//   • a token: the access token as the username with the literal password `token`
//              (`<accessToken>:token`)
// Both collapse to a single `Authorization: Basic base64(user:pass)` header here.
//
// Every NON-GET request (POST/PUT/DELETE) must carry an `X-Requested-By` header —
// Graylog's CSRF guard rejects writes without it (HTTP 400). It is added to every
// write automatically.
//
// Self-hosted Graylog commonly sits behind a self-signed certificate, so the HTTPS
// transport accepts untrusted certs (rejectUnauthorized:false), same posture as the
// misp / security-onion clients. The transport is protocol-aware: an http:// base
// goes over node:http, everything else over node:https.
//
// Docs: https://go2docs.graylog.org/current/setting_up_graylog/rest_api.htm
//       https://go2docs.graylog.org/current/setting_up_graylog/rest_api_access_tokens.htm
// =============================================================================

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** Graylog's default REST API port. */
export const DEFAULT_GRAYLOG_PORT = 9000

/** Value sent in the X-Requested-By CSRF-guard header on every write. */
export const REQUESTED_BY = 'veltrix'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * Base URL for the Graylog REST API (no trailing slash, no `/api` suffix — callers
 * append `/api/...`). Prefers an explicit connectivity URL, then honours a scheme
 * already present on the host, otherwise defaults to HTTPS (self-signed tolerated)
 * on the configured port (443 → no port suffix).
 */
export function buildGraylogUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const host = resolveHost(component, connectivity, provider).trim()
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '')
  const port = Number(component.port) || DEFAULT_GRAYLOG_PORT
  const scheme = port === 443 ? 'https' : port === 80 ? 'http' : 'https'
  const portPart = port === 443 || port === 80 ? '' : `:${port}`
  return `${scheme}://${host}${portPart}`
}

/**
 * Graylog Basic-auth header. Two credential shapes collapse to the same header:
 *   • an access token stored as `apiToken`   → `Basic base64(<token>:token)`
 *   • a username + password                  → `Basic base64(<username>:<password>)`
 * Returns an empty object when nothing usable is present — callers require a
 * credential before applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  let user = ''
  let pass = ''
  if (credential.apiToken) {
    // Access-token form: the token is the username, the password is literally "token".
    user = credential.apiToken
    pass = 'token'
  } else if (credential.username) {
    user = credential.username
    pass = credential.password || ''
  } else {
    return {}
  }
  const basic = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
  return { Authorization: `Basic ${basic}` }
}

export interface GraylogResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One REST request that tolerates Graylog's self-signed certificate. Uses
 * node:https / node:http directly (chosen by the URL protocol) so the platform's
 * global fetch settings don't reject an untrusted cert. Graylog expects
 * `Accept: application/json` on every request (defaulted here).
 */
export function graylogRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<GraylogResponse> {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const doRequest = isHttps ? httpsRequest : httpRequest
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        // Graylog self-hosted commonly ships a self-signed cert (https only).
        ...(isHttps ? { rejectUnauthorized: false } : {}),
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

export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<T> {
  const res = await graylogRequest(url, { headers, timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

/**
 * A write (POST/PUT/DELETE). Adds the mandatory `X-Requested-By` CSRF-guard header
 * and a JSON content type. A DELETE with no body is fine.
 */
export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await graylogRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-By': REQUESTED_BY, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
