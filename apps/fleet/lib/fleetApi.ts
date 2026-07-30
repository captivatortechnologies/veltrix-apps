// =============================================================================
// Fleet (osquery fleet management) access seam.
//
// Fleet is managed over a single HTTPS REST API rooted at /api/v1/fleet. Unlike
// Security Onion (Salt-driven, ctx.remote.command), Fleet has no CLI/Salt path —
// every operation is a REST call, so this seam is REST-only.
//
// Fleet servers are frequently fronted with a self-signed certificate (self-
// hosted, behind a load balancer, or on the default 8080 listener), so the
// transport accepts untrusted certs via node:https rejectUnauthorized:false —
// the same posture as splunk-enterprise / security-onion. Verify TLS expectations
// against your live Fleet (fleetdm) instance.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_FLEET_PORT = 443

/** REST base path every Fleet resource hangs off (queries, version, me, …). */
export const FLEET_API_BASE = '/api/v1/fleet'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * HTTPS origin for the Fleet server (no trailing slash, no /api/v1/fleet suffix).
 * Handlers append `${FLEET_API_BASE}/…`. Prefers an explicit connectivity URL.
 */
export function buildFleetUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = component.port || DEFAULT_FLEET_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/**
 * Fleet authenticates with a bearer token (an API-only user token or a session
 * token from POST /api/v1/fleet/login). credential.apiToken holds it; some
 * operators store it as the credential password, so fall back to that.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  const token = credential.apiToken ?? credential.password ?? ''
  return { Authorization: `Bearer ${token}` }
}

export interface FleetResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates Fleet's (often self-signed) certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert.
 */
export function fleetRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<FleetResponse> {
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
        rejectUnauthorized: false, // Fleet servers commonly ship self-signed certs
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
  const res = await fleetRequest(url, { headers, timeoutMs })
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
  const res = await fleetRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
