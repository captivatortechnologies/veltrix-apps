// =============================================================================
// SonarQube access seam.
//
// One path: HTTP(S) REST against the SonarQube Web API, rooted at `<base>/api`.
// Self-hosted SonarQube servers commonly sit behind a self-signed certificate, so
// the HTTPS transport accepts untrusted certs (same posture as misp / security-onion)
// via node:https with rejectUnauthorized:false. A plain-http endpoint (e.g. the
// SonarQube default http://<host>:9000) is honoured too — the transport is chosen
// from the URL scheme.
//
// Auth is a SonarQube token, carried as HTTP Basic with the token as the USERNAME
// and an EMPTY password: `Authorization: Basic base64("<token>:")`. This works on
// every SonarQube version. Newer servers (9.x+) also accept the bearer scheme
// (`Authorization: Bearer <token>`); Basic-with-empty-password is used here for the
// broadest compatibility. The token is stored as the connection credential's apiToken.
//
// SonarQube write endpoints (create, create_condition, …) take
// application/x-www-form-urlencoded parameters, NOT JSON; read endpoints (list,
// show, system/status) take query-string parameters. Both are covered below.
//
// Confirmed against the SonarQube Web API docs (docs.sonarsource.com); condition
// parameter names (gateName/metric/op/error) and system/status shape verified.
// Verify param nuances against your live SonarQube instance/version.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** SonarQube's documented default HTTP port. */
export const DEFAULT_SONARQUBE_PORT = 9000

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * HTTP(S) base for the SonarQube server (no trailing slash). The Web API lives
 * under `<base>/api`. Prefers an explicit connectivity URL, then an explicit
 * scheme on the component host, and otherwise assumes https on the component port.
 */
export function buildSonarqubeUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const host = resolveHost(component, connectivity, provider)
  if (/^https?:\/\//i.test(host)) return host.replace(/\/+$/, '')
  const port = component.port || DEFAULT_SONARQUBE_PORT
  const suffix = Number(port) === 443 ? '' : `:${port}`
  return `https://${host}${suffix}`.replace(/\/+$/, '')
}

/**
 * SonarQube authorization header: the token as HTTP Basic username with an empty
 * password. Returns an empty object when no token is present — callers require a
 * credential before applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) {
    const basic = Buffer.from(`${credential.apiToken}:`, 'utf8').toString('base64')
    return { Authorization: `Basic ${basic}` }
  }
  return {}
}

/** A form param value: a scalar, or an array for a repeated field (see below). */
export type FormParamValue = string | number | boolean | string[] | undefined | null

/**
 * Encode a flat param map as application/x-www-form-urlencoded, dropping blanks.
 * An array value is encoded as the SAME key repeated once per element (SonarQube's
 * convention for multi-value params, e.g. `api/settings/set`'s `values` and
 * `fieldValues`) — blank/nullish elements are dropped individually.
 */
export function formEncode(params: Record<string, FormParamValue>): string {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null || v === '') continue
        usp.append(key, String(v))
      }
      continue
    }
    usp.append(key, String(value))
  }
  return usp.toString()
}

export interface SonarqubeResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTP(S) request. The transport module is chosen from the URL scheme; the
 * HTTPS path tolerates SonarQube's self-signed certificate (node:https directly, so
 * the platform's global fetch settings don't reject the untrusted cert). SonarQube
 * answers JSON when asked (Accept defaulted here).
 */
export function sonarqubeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<SonarqubeResponse> {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const requestFn = isHttps ? httpsRequest : httpRequest
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: false } : {}), // self-hosted SonarQube often ships self-signed certs
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

/** GET a JSON resource (query-string params already on the URL). */
export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<T> {
  const res = await sonarqubeRequest(url, { headers, timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

/**
 * POST form-encoded params (the SonarQube write convention) and parse any JSON
 * response. An empty 2xx body (common for destroy / set_as_default) resolves to {}.
 */
export async function postForm<T>(
  url: string,
  headers: Record<string, string>,
  params: Record<string, FormParamValue>,
  timeoutMs?: number,
): Promise<T> {
  const res = await sonarqubeRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: formEncode(params),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`POST ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
