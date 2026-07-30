// =============================================================================
// MISP access seam.
//
// One path: HTTPS REST against the MISP web/API tier (443). MISP commonly ships a
// self-signed certificate, so the transport accepts untrusted certs (same posture
// as security-onion's soConsole / splunk-enterprise's client) via node:https with
// rejectUnauthorized:false.
//
// Auth is a single MISP "automation key" carried in the Authorization header
// verbatim (NOT a Bearer prefix): `Authorization: <apiKey>`. The key is stored as
// the connection credential's apiToken.
//
// NOTE: API shapes here follow MISP 2.4 conventions (/servers/getVersion, /feeds,
// /feeds/add, /feeds/edit/{id}). Verify against a live MISP 2.4 instance.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_MISP_PORT = 443

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the MISP web UI / REST API (443). Prefers an explicit URL. */
export function buildMispUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = component.port || DEFAULT_MISP_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/**
 * MISP authorization header. The automation key is sent verbatim as the
 * Authorization value (MISP does not use a Bearer prefix). Returns an empty object
 * when no key is present — callers require a credential before applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) return { Authorization: credential.apiToken }
  return {}
}

export interface MispResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates MISP's self-signed certificate. Uses node:https
 * directly so the platform's global fetch settings don't reject the untrusted cert.
 * MISP expects `Accept: application/json` on every request (defaulted here).
 */
export function mispRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<MispResponse> {
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
        rejectUnauthorized: false, // MISP commonly ships self-signed certs
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
  const res = await mispRequest(url, { headers, timeoutMs })
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
  const res = await mispRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
