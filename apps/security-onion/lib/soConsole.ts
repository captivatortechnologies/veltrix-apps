// =============================================================================
// Security Onion access seam.
//
// Two paths, mirroring how the grid is actually managed:
//   1. HTTPS REST — the SOC console / Kibana detection engine (443) and
//      Elasticsearch (9200). Self-signed by default, so the transport accepts
//      untrusted certs (same posture as splunk-enterprise's client).
//   2. ctx.remote.command — the manager owns the grid via Salt, so Suricata
//      rules, firewall access, users and highstate are applied by the app's
//      manifest-declared remoteCommands over managed ZTNA. The platform validates
//      every param and shell-quotes it; this app never builds a shell string.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef, RemoteExecutor } from '@veltrixsecops/app-sdk'

export const DEFAULT_SOC_PORT = 443
export const DEFAULT_ES_PORT = 9200

/** Manifest-declared remoteCommands ids (kept in sync with manifest.yaml `remoteCommands`). */
export const SO_CMD = {
  saltHighstate: 'salt-highstate',
  soRule: 'so-rule',
  soFirewall: 'so-firewall',
  soUser: 'so-user',
  zeekToggle: 'zeek-toggle',
} as const

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the SOC console / Kibana detection engine (443). Prefers an explicit URL. */
export function buildSocUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = component.port || DEFAULT_SOC_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/** HTTPS base for Elasticsearch REST (9200) — ILM policies, index templates. */
export function buildEsUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  return `https://${resolveHost(component, connectivity, provider)}:${DEFAULT_ES_PORT}`
}

export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  const encoded = Buffer.from(`${credential.username ?? ''}:${credential.password ?? ''}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

export interface SoResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates Security Onion's self-signed certificate. Uses
 * node:https directly (like splunk-enterprise) so the platform's global fetch
 * settings don't reject the untrusted cert.
 */
export function soRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<SoResponse> {
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
        rejectUnauthorized: false, // Security Onion ships self-signed certs
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
  const res = await soRequest(url, { headers, timeoutMs })
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
  const res = await soRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}

// --- Salt / CLI over ctx.remote.command ------------------------------------

/** Throw a clear, consistent error when a Salt/CLI op is attempted without managed connectivity. */
export function requireRemote(remote: RemoteExecutor | undefined): asserts remote is RemoteExecutor {
  if (!remote || typeof remote.command !== 'function') {
    throw new Error(
      'This operation is applied on the Security Onion manager via Salt and requires managed connectivity (ctx.remote). Attach the manager over managed ZTNA.',
    )
  }
}

/** Run one manifest-declared remote command on the manager; throw on non-zero exit. */
export async function soCommand(
  remote: RemoteExecutor | undefined,
  id: string,
  params: Record<string, string> = {},
): Promise<string> {
  requireRemote(remote)
  const res = await remote.command!(id, params)
  if (!res.ok) throw new Error(`${id} ${JSON.stringify(params)} failed (${res.code ?? '?'}): ${(res.stderr || res.stdout).slice(0, 300)}`)
  return res.stdout
}

/** Apply Salt highstate on the manager so pillar/state changes take effect grid-wide. */
export async function applyHighstate(remote: RemoteExecutor | undefined): Promise<string> {
  return soCommand(remote, SO_CMD.saltHighstate)
}
