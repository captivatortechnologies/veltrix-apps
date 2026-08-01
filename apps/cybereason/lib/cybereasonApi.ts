// =============================================================================
// Cybereason access seam.
//
// One path: HTTPS REST against the Cybereason Defense Platform tenant. Auth is a
// SESSION-COOKIE login — POST an x-www-form-urlencoded body (`username` /
// `password`) to `/login.html`; on success Cybereason returns a `JSESSIONID`
// cookie which is replayed as `Cookie: JSESSIONID=...` on every subsequent
// `/rest/...` JSON call.
//
// Custom reputations are read/written through:
//   read:  GET  /rest/classification/download   → CSV of all custom reputations
//   write: POST /rest/classification/update      → JSON array of update entries
//
// Cybereason tenants are public SaaS at `https://<tenant>.cybereason.net`, which
// present a valid TLS certificate — so, unlike MISP, this transport does NOT
// relax certificate verification.
//
// VERIFY AGAINST A LIVE CYBEREASON: the login success/failure signalling (302 vs
// a 200 login page), the classification/update response body, and the
// classification/download CSV column layout are documented from public
// integrations, not an official API contract — the parsers here are defensive.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_CYBEREASON_PORT = 443
export const LOGIN_PATH = '/login.html'
export const CLASSIFICATION_UPDATE_PATH = '/rest/classification/update'
export const CLASSIFICATION_DOWNLOAD_PATH = '/rest/classification/download'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the Cybereason tenant (443). Prefers an explicit URL. */
export function buildCybereasonUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = component.port || DEFAULT_CYBEREASON_PORT
  return `https://${resolveHost(component, connectivity, provider)}${String(port) === '443' ? '' : `:${port}`}`
}

/** Normalize a raw tenant endpoint/host into an https base URL with no trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

export interface CybereasonResponse {
  status: number
  ok: boolean
  body: string
  headers: Record<string, string | string[] | undefined>
}

interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** One HTTPS request against the Cybereason tenant. Exposes response headers so the caller can read Set-Cookie. */
export function cybereasonRequest(url: string, init: RequestInit = {}): Promise<CybereasonResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
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
            headers: res.headers as Record<string, string | string[] | undefined>,
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

/** Pull the JSESSIONID value out of a Set-Cookie header (string or array). */
export function extractJSessionId(setCookie: string | string[] | undefined): string | null {
  if (!setCookie) return null
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const raw of cookies) {
    const match = /(?:^|;\s*)JSESSIONID=([^;]+)/i.exec(raw)
    if (match) return match[1]
  }
  return null
}

/**
 * A body that looks like Cybereason's HTML login page rather than an API
 * payload — the tell that a session is unauthenticated / expired. `/rest` calls
 * answer with JSON or CSV, never an HTML document.
 */
export function looksLikeLoginPage(body: string): boolean {
  const head = body.slice(0, 400).toLowerCase()
  return head.includes('<html') || head.includes('<!doctype html') || head.includes('j_username')
}

/** An authenticated Cybereason session: a base URL + the JSESSIONID cookie to replay. */
export interface CybereasonSession {
  base: string
  cookie: string
  get(path: string, headers?: Record<string, string>): Promise<CybereasonResponse>
  postJson(path: string, body: unknown, headers?: Record<string, string>): Promise<CybereasonResponse>
}

export class CybereasonAuthError extends Error {}

/**
 * Log in with username / password and return the JSESSIONID cookie value.
 * Throws {@link CybereasonAuthError} when Cybereason answers with the login page
 * again (bad credentials) or never issues a session cookie.
 */
export async function login(base: string, credential: CredentialRef, timeoutMs = 15_000): Promise<string> {
  const username = (credential.username ?? '').trim()
  const password = credential.password ?? ''
  if (!username || !password) {
    throw new CybereasonAuthError('Cybereason authenticates with a username and password — attach both to this connection.')
  }

  const form = new URLSearchParams({ username, password }).toString()
  const res = await cybereasonRequest(`${base}${LOGIN_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/json',
      'Content-Length': String(Buffer.byteLength(form)),
    },
    body: form,
    timeoutMs,
  })

  const cookie = extractJSessionId(res.headers['set-cookie'])
  // Success is a 302 redirect (to "/") carrying the authenticated JSESSIONID.
  // A 200 that returns the login page again means the credentials were rejected.
  const isRedirect = res.status >= 300 && res.status < 400
  if (!cookie) {
    if (res.status === 401 || res.status === 403) {
      throw new CybereasonAuthError(`Cybereason rejected the credentials (HTTP ${res.status}).`)
    }
    throw new CybereasonAuthError(`Cybereason did not issue a session cookie (HTTP ${res.status}).`)
  }
  if (!isRedirect && looksLikeLoginPage(res.body)) {
    throw new CybereasonAuthError('Cybereason rejected the username / password (returned the login page).')
  }
  return cookie
}

/** Log in and return a session that replays the JSESSIONID cookie on every call. */
export async function createSession(base: string, credential: CredentialRef, timeoutMs = 15_000): Promise<CybereasonSession> {
  const cookie = await login(base, credential, timeoutMs)
  const cookieHeader = `JSESSIONID=${cookie}`
  return {
    base,
    cookie,
    get(path, headers) {
      return cybereasonRequest(`${base}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json,text/csv,text/plain', Cookie: cookieHeader, ...(headers ?? {}) },
        timeoutMs,
      })
    },
    postJson(path, body, headers) {
      return cybereasonRequest(`${base}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: cookieHeader,
          ...(headers ?? {}),
        },
        body: JSON.stringify(body),
        timeoutMs,
      })
    },
  }
}

/** The timeout (ms) to use for a request, from the app setting `request_timeout_seconds`. */
export function resolveTimeoutMs(settings: Record<string, unknown> | undefined, fallbackMs = 15_000): number {
  const seconds = Number((settings ?? {}).request_timeout_seconds)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs
}
