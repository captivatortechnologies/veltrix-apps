// =============================================================================
// Tanium access seam.
//
// One path: HTTPS REST against the Tanium Server / Tanium Cloud (443), base
// `https://<server>/api/v2`. Tanium appliances commonly present a self-signed
// certificate, so the transport accepts untrusted certs (same posture as MISP's
// mispApi / security-onion's soConsole) via node:https with rejectUnauthorized:false.
//
// AUTH SEAM (isolated in resolveTaniumSession): every REST call carries a
// `session:` header. The value is resolved from the connection credential two ways:
//   - API token  → the token IS the session header value; no login round-trip.
//   - username + password → POST /api/v2/session/login { username, password } and
//     read the returned session string from `data.session`.
// Tanium does NOT use an `Authorization` / `Bearer` header — that returns 401.
//
// VERIFY AGAINST A LIVE TANIUM: the REST v2 shapes below (/session/login,
// /system_status, /groups, /groups/{id}, /groups/by-name/{name}) follow Tanium
// REST v2 conventions confirmed from Tanium's public integrations (Cortex XSOAR
// Tanium_v2, Splunk SOAR taniumrest) and community docs. PUT /groups/{id} for an
// in-place update is a REST v2 convention not exercised by those integrations —
// verify it against a live Tanium (some builds require delete + recreate).
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_TANIUM_PORT = 443

/** The REST v2 path segment appended to the server origin. */
const API_V2 = '/api/v2'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** `https://host[:port]` origin for the Tanium server, with no trailing slash. */
export function buildTaniumOrigin(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return stripApiSuffix(connectivity.httpsUrl.replace(/\/+$/, ''))
  const port = Number(component.port) || DEFAULT_TANIUM_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/** REST v2 base (`https://host[:port]/api/v2`) for the Tanium server. */
export function buildTaniumBaseUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  return `${buildTaniumOrigin(component, connectivity, provider)}${API_V2}`
}

/** Normalize any raw endpoint/host into a `https://host[:port]/api/v2` base. */
export function baseUrlFromEndpoint(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return `${stripApiSuffix(withScheme.replace(/\/+$/, ''))}${API_V2}`
}

/** Drop a trailing `/api/v2` (any casing) so callers can append it exactly once. */
function stripApiSuffix(url: string): string {
  return url.replace(/\/api\/v2\/?$/i, '')
}

export interface TaniumResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates Tanium's self-signed certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. Tanium expects `Accept: application/json` on every request.
 */
export function taniumRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<TaniumResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: false, // Tanium appliances commonly ship self-signed certs
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

/**
 * Resolve the `session` header value — the ISOLATED auth seam.
 *
 *   API token       → returned verbatim (no login round-trip).
 *   username + pass  → POST {base}/session/login { username, password }; read
 *                      `data.session` from the response.
 *
 * `base` is the REST v2 base (…/api/v2). Throws when neither auth path is usable
 * or when login fails, so callers surface a clear credential error.
 */
export async function resolveTaniumSession(base: string, credential: CredentialRef, timeoutMs = 15_000): Promise<string> {
  if (credential.apiToken && credential.apiToken.trim()) return credential.apiToken.trim()

  const username = (credential.username ?? '').trim()
  const password = credential.password ?? ''
  if (!username || !password) {
    throw new Error('Tanium needs an API token, or a username and password, on the connection credential.')
  }

  const res = await taniumRequest(`${base}/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`POST ${base}/session/login → HTTP ${res.status}: ${res.body.slice(0, 200)}`)

  const session = extractSession(res.body)
  if (!session) throw new Error('Tanium login succeeded but returned no session token.')
  return session
}

/** Pull the session string from a login response — `{ data: { session } }` or a bare `{ session }`. */
function extractSession(body: string): string | null {
  try {
    const parsed = JSON.parse(body || '{}') as { data?: { session?: unknown }; session?: unknown }
    const raw = parsed.data?.session ?? parsed.session
    return typeof raw === 'string' && raw ? raw : null
  } catch {
    return null
  }
}

/** The `session:` auth header for every authenticated REST call. */
export function sessionHeader(session: string): Record<string, string> {
  return { session }
}

export async function getJson<T>(url: string, session: string, timeoutMs?: number): Promise<T> {
  const res = await taniumRequest(url, { headers: sessionHeader(session), timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  session: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await taniumRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...sessionHeader(session) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
