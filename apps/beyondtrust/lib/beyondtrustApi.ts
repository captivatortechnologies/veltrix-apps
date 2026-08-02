// =============================================================================
// BeyondTrust Password Safe access seam.
//
// One path: HTTPS REST against the BeyondInsight / Password Safe web API tier
// (443). On-premises BeyondInsight commonly ships a self-signed certificate, so
// the transport accepts untrusted certs (same posture as MISP's mispApi) via
// node:https with rejectUnauthorized:false.
//
// Auth is a SESSION, not a per-request header:
//   1. POST /Auth/SignAppIn with `Authorization: PS-Auth key=<api-key>; runas=<user>;`
//      returns 200 + a session cookie (ASP.NET_SessionId).
//   2. Subsequent REST calls carry that cookie (Cookie header) — NOT the PS-Auth
//      header.
//   3. POST /Auth/Signout ends the session.
//
// The API key is stored as the connection credential's apiToken; the run-as user
// is the credential's username. Base URL is `https://<host>/BeyondTrust/api/public/v3`.
//
// NOTE: endpoint shapes follow the BeyondInsight/Password Safe public v3 API and
// should be verified against a live BeyondTrust instance.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_PS_PORT = 443
/** The fixed public API base path every BeyondInsight/Password Safe host exposes. */
export const API_BASE_PATH = '/BeyondTrust/api/public/v3'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * HTTPS base for the Password Safe public API, always ending in
 * `/BeyondTrust/api/public/v3` (no trailing slash). Prefers an explicit URL; a
 * URL that already includes the API base path is not double-appended.
 */
export function buildPasswordSafeUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  let origin: string
  if (connectivity?.httpsUrl) {
    origin = connectivity.httpsUrl.replace(/\/+$/, '')
    origin = origin.replace(new RegExp(`${API_BASE_PATH}/?$`, 'i'), '')
  } else {
    const port = component.port ? Number(component.port) : DEFAULT_PS_PORT
    origin = `https://${resolveHost(component, connectivity, provider)}${port === DEFAULT_PS_PORT ? '' : `:${port}`}`
  }
  return `${origin}${API_BASE_PATH}`
}

/**
 * PS-Auth authorization header for POST /Auth/SignAppIn. The API key is the
 * credential's apiToken; the run-as user is the credential's username. Returns an
 * empty object when no key is present — callers require a credential before
 * signing in. `pwd=` is only needed when "User Password" is enabled on the API
 * registration; omitted here (see README).
 */
export function buildPsAuthHeader(credential: CredentialRef): Record<string, string> {
  const key = (credential.apiToken ?? '').trim()
  if (!key) return {}
  const runas = (credential.username ?? '').trim()
  return { Authorization: `PS-Auth key=${key};${runas ? ` runas=${runas};` : ''}` }
}

export interface PsResponse {
  status: number
  ok: boolean
  body: string
  /** Session cookie(s) collapsed to a single `name=value; name=value` Cookie value, or null. */
  cookie: string | null
}

/** Collapse a Set-Cookie header array into a single Cookie request value. */
function collapseCookies(setCookie: string[] | string | undefined): string | null {
  if (!setCookie) return null
  const list = Array.isArray(setCookie) ? setCookie : [setCookie]
  const pairs = list.map((c) => c.split(';')[0].trim()).filter(Boolean)
  return pairs.length ? pairs.join('; ') : null
}

/**
 * One HTTPS request that tolerates Password Safe's self-signed certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. Captures any Set-Cookie so the session can be carried forward.
 */
export function psRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<PsResponse> {
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
        rejectUnauthorized: false, // on-prem BeyondInsight commonly ships self-signed certs
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body: Buffer.concat(chunks).toString('utf8'),
            cookie: collapseCookies(res.headers['set-cookie']),
          })
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
 * Start a Password Safe session: POST /Auth/SignAppIn with the PS-Auth header.
 * Returns the session cookie subsequent requests must carry. Throws on any
 * non-2xx response or a missing cookie.
 */
export async function signAppIn(base: string, credential: CredentialRef, timeoutMs?: number): Promise<string> {
  const auth = buildPsAuthHeader(credential)
  if (!auth.Authorization) throw new Error('Missing API key (PS-Auth) for BeyondTrust sign-in')
  const res = await psRequest(`${base}/Auth/SignAppIn`, { method: 'POST', headers: auth, timeoutMs })
  if (!res.ok) throw new Error(`SignAppIn → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  if (!res.cookie) throw new Error('SignAppIn succeeded but returned no session cookie')
  return res.cookie
}

/** End a Password Safe session (best-effort): POST /Auth/Signout with the cookie. */
export async function signOut(base: string, cookie: string, timeoutMs?: number): Promise<void> {
  try {
    await psRequest(`${base}/Auth/Signout`, { method: 'POST', headers: { Cookie: cookie }, timeoutMs })
  } catch {
    // Signout is best-effort — a failure here must never fail the caller.
  }
}

export async function getJson<T>(base: string, path: string, cookie: string, timeoutMs?: number): Promise<T> {
  const res = await psRequest(`${base}${path}`, { headers: { Cookie: cookie }, timeoutMs })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || 'null') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PUT',
  base: string,
  path: string,
  cookie: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await psRequest(`${base}${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}

/** DELETE a resource. Password Safe returns 200 + a plain-text message, so the body is not parsed. */
export async function deletePath(base: string, path: string, cookie: string, timeoutMs?: number): Promise<void> {
  const res = await psRequest(`${base}${path}`, { method: 'DELETE', headers: { Cookie: cookie }, timeoutMs })
  if (!res.ok) throw new Error(`DELETE ${path} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
}

/**
 * Run `fn` inside a signed-in Password Safe session, always signing out
 * afterwards. The whole flow is: SignAppIn → fn(cookie) → Signout.
 */
export async function withSession<T>(
  base: string,
  credential: CredentialRef,
  fn: (cookie: string) => Promise<T>,
): Promise<T> {
  const cookie = await signAppIn(base, credential)
  try {
    return await fn(cookie)
  } finally {
    await signOut(base, cookie)
  }
}
