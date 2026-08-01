// =============================================================================
// Axonius access seam.
//
// One path: HTTPS REST against the Axonius tenant (443). Axonius on-prem
// deployments commonly ship a self-signed certificate, so the transport accepts
// untrusted certs by default (same posture as misp / security-onion) via
// node:https with rejectUnauthorized:false — flip the `verify_tls` app setting on
// for a cloud tenant with a valid certificate.
//
// Auth is a service-account API key + secret, carried in two request headers:
//   api-key:    <key>       (stored as the connection credential's username)
//   api-secret: <secret>    (stored as the connection credential's apiToken)
// Confirmed against axonius_api_client/auth/api_key.py (session headers).
//
// The REST surface is JSON:API. Reads answer with a { data: [...], meta } envelope
// where each row is { id, type, attributes }; writes expect a
// { data: { type, attributes } } body with Content-Type application/vnd.api+json
// (confirmed against axonius_api_client/http.py). Endpoint paths follow the
// axonius-api-client (api/queries/..., api/settings/meta/about) — UNVERSIONED. Some
// Axonius tenants expose a versioned root (e.g. /api/V4.0/); set the `api_version`
// app setting to insert that segment. Verify all shapes against a live Axonius.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_AXONIUS_PORT = 443

/** JSON:API media type Axonius expects on write bodies (http.py default). */
const JSON_API_CONTENT_TYPE = 'application/vnd.api+json'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the Axonius tenant (443), no trailing slash. Prefers an explicit URL. */
export function buildAxoniusUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = Number(component.port) || DEFAULT_AXONIUS_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/**
 * REST API root segment. Defaults to the unversioned `api/` used by the
 * axonius-api-client; when the tenant requires a versioned root the operator sets
 * the `api_version` setting (e.g. "V4.0") and it becomes `api/V4.0/`.
 */
export function apiRoot(settings: Record<string, unknown> | undefined): string {
  const raw = settings?.api_version
  const version = typeof raw === 'string' ? raw.trim().replace(/^\/+|\/+$/g, '') : ''
  return version ? `api/${version}` : 'api'
}

/** Build a full endpoint URL from the tenant base, the API root and a resource path. */
export function apiUrl(base: string, settings: Record<string, unknown> | undefined, resource: string): string {
  return `${base}/${apiRoot(settings)}/${resource.replace(/^\/+/, '')}`
}

/**
 * Axonius auth headers. The API key is the credential username and the API secret
 * is the credential apiToken (falling back to password). Returns an empty object
 * when either half is missing — callers require a full credential before applying.
 */
export function buildAuthHeaders(credential: CredentialRef): Record<string, string> {
  const key = credential.username?.trim()
  const secret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!key || !secret) return {}
  return { 'api-key': key, 'api-secret': secret }
}

/** Whether a full api-key + api-secret pair is present on the credential. */
export function hasApiCredentials(credential: CredentialRef | null | undefined): boolean {
  if (!credential) return false
  return Object.keys(buildAuthHeaders(credential)).length === 2
}

/** Read the `verify_tls` setting — off by default (Axonius on-prem is often self-signed). */
export function verifyTls(settings: Record<string, unknown> | undefined): boolean {
  return settings?.verify_tls === true
}

export interface AxoniusResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request. Uses node:https directly so the platform's global fetch
 * settings don't reject an untrusted cert; `verifyTls` (default false) tolerates a
 * self-signed certificate. Sends Accept: application/vnd.api+json on every request.
 */
export function axoniusRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<AxoniusResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: JSON_API_CONTENT_TYPE, ...(init.headers ?? {}) },
        rejectUnauthorized: init.verifyTls === true,
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

export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<T> {
  const res = await axoniusRequest(url, { headers, ...opts })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  opts: { timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<T> {
  const res = await axoniusRequest(url, {
    method,
    headers: { 'Content-Type': JSON_API_CONTENT_TYPE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
