// =============================================================================
// Wazuh access seam.
//
// Wazuh is managed entirely over its REST API on port 55000. The manager ships a
// self-signed certificate by default, so the transport accepts untrusted certs
// (same posture as security-onion's soConsole / splunk-enterprise's client) via
// node:https directly, bypassing the platform's global fetch settings.
//
// Auth is a two-step token flow (verify against a live Wazuh 4.x manager):
//   1. POST /security/user/authenticate  with HTTP Basic (username:password)
//      → { data: { token: "<jwt>" } }
//   2. Every subsequent call carries  Authorization: Bearer <token>
// Tokens are short-lived (Wazuh default ~15 min), so each pipeline run
// re-authenticates rather than caching.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_WAZUH_API_PORT = 55000

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * HTTPS base for the Wazuh manager REST API (55000). Unlike the dashboard (443),
 * the API always lives on its own port — a connectivity `httpsUrl` (which points
 * at the analyst dashboard) is deliberately NOT used here; the port falls back to
 * the component's port or the 55000 default.
 */
export function buildWazuhUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  const port = component.port || DEFAULT_WAZUH_API_PORT
  return `https://${resolveHost(component, connectivity, provider)}:${port}`
}

export function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function basicHeader(credential: CredentialRef): Record<string, string> {
  const encoded = Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

export interface WazuhResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates Wazuh's self-signed certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. `body` is written verbatim — JSON for API calls, or a raw CDB
 * file for the /lists/files upload.
 */
export function wazuhRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<WazuhResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || DEFAULT_WAZUH_API_PORT,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: false, // Wazuh ships self-signed certs
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
  const res = await wazuhRequest(url, { headers, timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await wazuhRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}

// --- Authentication --------------------------------------------------------

/** Shape of the /security/user/authenticate response envelope. */
interface AuthResponse {
  data?: { token?: string }
}

/**
 * Exchange a credential's Basic auth for a bearer token against
 * POST /security/user/authenticate. Throws on a non-2xx (the caller distinguishes
 * 401 as a bad credential); throws too if the response omits a token.
 */
export async function authenticate(baseUrl: string, credential: CredentialRef): Promise<string> {
  const res = await wazuhRequest(`${baseUrl}/security/user/authenticate`, {
    method: 'POST',
    headers: basicHeader(credential),
  })
  if (!res.ok) throw new Error(`Wazuh authenticate → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const parsed = JSON.parse(res.body || '{}') as AuthResponse
  const token = parsed.data?.token
  if (!token) throw new Error('Wazuh authenticate: no token in response')
  return token
}

/**
 * Resolve a usable API base + bearer token from a credential. A credential that
 * already carries a long-lived `apiToken` is used directly; otherwise a fresh
 * token is minted from its username/password.
 */
export async function getToken(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider: ProviderLike,
  credential: CredentialRef,
): Promise<{ baseUrl: string; token: string }> {
  const baseUrl = buildWazuhUrl(component, connectivity, provider)
  if (credential.apiToken) return { baseUrl, token: credential.apiToken }
  const token = await authenticate(baseUrl, credential)
  return { baseUrl, token }
}
