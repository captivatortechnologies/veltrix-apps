// =============================================================================
// Vectra AI (NDR) access seam.
//
// One path: HTTPS REST against the Vectra Detect API tier (443). On-prem Vectra
// "brain" appliances commonly ship a self-signed certificate, so the transport
// accepts untrusted certs (same posture as misp / security-onion) via node:https
// with rejectUnauthorized:false. (Vectra SaaS tenants present a valid cert — the
// `verify_tls` app setting is the operator's lever to enforce it there.)
//
// PRIMARY API: Vectra Detect v2.5. Auth is a single API token carried as
// `Authorization: Token <token>` (note the literal `Token ` prefix, NOT Bearer).
// The token is stored as the connection credential's apiToken.
//
// ALTERNATE (not implemented in this foundation): the newer Vectra platform v3
// (RUX / Respond) uses OAuth2 client-credentials (POST /oauth2/token → a Bearer
// access token). See README. Base URL is the same host, /api/v3/.
//
// NOTE: endpoint shapes here follow the Vectra Detect v2.5 API; verify against a
// live Vectra brain. See config-types/triage-rules for the /rules CRUD.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** Vectra Detect API version this foundation targets. */
export const VECTRA_API_VERSION = 'v2.5'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * HTTPS origin for the Vectra brain (443). Prefers an explicit connectivity URL,
 * otherwise `https://<host>`. Vectra serves its API on 443, so a non-standard
 * port is only honoured when the component carries one.
 */
export function buildVectraOrigin(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = String(component.port || '').trim()
  const host = resolveHost(component, connectivity, provider)
  return `https://${host}${port && port !== '443' ? `:${port}` : ''}`
}

/** Full API base including the version segment, e.g. `https://host/api/v2.5`. */
export function buildVectraApiBase(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  return `${buildVectraOrigin(component, connectivity, provider)}/api/${VECTRA_API_VERSION}`
}

/**
 * Vectra authorization header. The API token is sent as `Authorization: Token
 * <token>` (literal `Token ` prefix — NOT Bearer). Returns an empty object when no
 * token is present — callers require a credential before applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Token ${credential.apiToken}` }
  return {}
}

export interface VectraResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates Vectra's self-signed certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. Vectra returns JSON; `Accept: application/json` is defaulted.
 */
export function vectraRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<VectraResponse> {
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
        rejectUnauthorized: false, // Vectra brains commonly ship self-signed certs
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
  const res = await vectraRequest(url, { headers, timeoutMs })
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
  const res = await vectraRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
