// =============================================================================
// Cribl access seam.
//
// One path: HTTPS REST against the Cribl Leader (on-prem, default port 9000) or
// Cribl.Cloud workspace (443). On-prem Cribl commonly ships a self-signed
// certificate, so the transport accepts untrusted certs (same posture as
// misp's mispApi / splunk-enterprise's client) via node:https with
// rejectUnauthorized:false.
//
// Auth (two supported credential shapes, resolved by resolveBearer):
//   • on-prem  — username + password → POST /api/v1/auth/login → { token };
//                the token is then carried as `Authorization: Bearer <token>`.
//   • Cribl.Cloud / direct — a pre-obtained Bearer token stored as the
//                credential's apiToken (e.g. from the OAuth client-credentials
//                exchange at https://login.cribl.cloud/oauth/token). Carried
//                verbatim as `Authorization: Bearer <token>`.
//
// Worker-group / Edge-fleet scoping: group-scoped resources live under
// /api/v1/m/<group>/…; a single-instance (non-distributed) deployment omits the
// /m/<group> segment. groupResourcePath() builds the right one.
//
// NOTE: API shapes here follow the Cribl REST API (/api/v1/auth/login,
// /api/v1/m/<group>/pipelines, /api/v1/system/info) documented at
// https://docs.cribl.io/cribl-as-code/api-auth/ and
// https://docs.cribl.io/cribl-as-code/api/. Verify against a live Cribl.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** On-prem Cribl Leader REST API / UI port. Cribl.Cloud is served on 443. */
export const DEFAULT_CRIBL_PORT = 9000
/** Worker Group used by a single-Group license when a pipeline sets none. */
export const DEFAULT_WORKER_GROUP = 'default'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base (scheme + host [+ port], no trailing slash) for the Cribl endpoint. */
export function buildCriblUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
  defaultPort: number = DEFAULT_CRIBL_PORT,
): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = Number(component.port) || defaultPort
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/** The `/api/v1` root under a base host. */
export function apiRoot(base: string): string {
  return `${base.replace(/\/+$/, '')}/api/v1`
}

/**
 * Path to a group-scoped resource. A non-empty worker group / fleet resolves to
 * `/api/v1/m/<group>/<resource>`; a blank group (single-instance deployment)
 * resolves to `/api/v1/<resource>`.
 */
export function groupResourcePath(base: string, group: string | null | undefined, resource: string): string {
  const g = String(group ?? '').trim()
  const suffix = g ? `/m/${encodeURIComponent(g)}/${resource}` : `/${resource}`
  return `${apiRoot(base)}${suffix}`
}

export interface CriblResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates Cribl's self-signed certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. Cribl speaks JSON, so `Accept: application/json` is defaulted.
 */
export function criblRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<CriblResponse> {
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
        rejectUnauthorized: false, // on-prem Cribl commonly ships self-signed certs
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

/** Drop a leading `Bearer ` (case-insensitive) so we never double-prefix the header. */
function stripBearer(token: string): string {
  return token.replace(/^\s*Bearer\s+/i, '').trim()
}

interface LoginResponse {
  token?: string
  forcePasswordChange?: boolean
}

/**
 * On-prem login: POST /api/v1/auth/login { username, password } → { token }.
 * The returned token is the Bearer value for subsequent requests.
 */
export async function criblLogin(base: string, username: string, password: string, timeoutMs?: number): Promise<string> {
  const res = await criblRequest(`${apiRoot(base)}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    timeoutMs,
  })
  if (!res.ok) {
    throw new Error(`Cribl login failed (POST /api/v1/auth/login → HTTP ${res.status}): ${res.body.slice(0, 200)}`)
  }
  const parsed = (res.body ? JSON.parse(res.body) : {}) as LoginResponse
  if (!parsed.token) throw new Error('Cribl login returned no token.')
  return stripBearer(parsed.token)
}

/**
 * Resolve a Bearer token from a connection credential:
 *   • apiToken present            → use it verbatim (Cribl.Cloud / direct token).
 *   • username + password present → on-prem login for a fresh token.
 * Throws when neither is available — callers require a credential.
 */
export async function resolveBearer(base: string, credential: CredentialRef, timeoutMs?: number): Promise<string> {
  if (credential.apiToken && credential.apiToken.trim()) return stripBearer(credential.apiToken)
  if (credential.username && credential.password) {
    return criblLogin(base, credential.username, credential.password, timeoutMs)
  }
  throw new Error('Cribl needs a Bearer token (Cribl.Cloud) or a username + password (on-prem) on the connection credential.')
}

/** The Authorization header for a resolved Bearer token. */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

/**
 * Resolve a Bearer once and return ready-to-use auth headers. Handlers call this
 * a single time per run and reuse the headers across requests.
 */
export async function criblConnect(base: string, credential: CredentialRef, timeoutMs?: number): Promise<Record<string, string>> {
  return authHeader(await resolveBearer(base, credential, timeoutMs))
}

export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<T> {
  const res = await criblRequest(url, { headers, timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await criblRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
