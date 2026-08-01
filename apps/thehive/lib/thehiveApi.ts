// =============================================================================
// TheHive access seam.
//
// One path: REST against the TheHive web/API tier. TheHive is commonly fronted by
// a reverse proxy on 443 (self-signed certs are common) or served directly on
// 9000 — so the transport is protocol-aware (an explicit http:// endpoint uses
// node:http; otherwise node:https with rejectUnauthorized:false tolerates an
// untrusted cert, same posture as the misp / security-onion seams).
//
// Auth is a TheHive API key carried as a Bearer token:
//   `Authorization: Bearer <apiKey>`
// The key is stored as the connection credential's apiToken.
//
// ---------------------------------------------------------------------------
// TheHive 4 vs 5 API SEAM (the ONE place the version difference lives)
// ---------------------------------------------------------------------------
// PRIMARY  → TheHive 5 (StrangeBee):   /api/v1/...   (case templates at
//            /api/v1/caseTemplate, listed via POST /api/v1/query).
// ALTERNATE→ TheHive 4 (legacy):       /api/case/template (+ /_search for list).
//
// v5 is the primary because the maintained clients target it; the v4 paths are
// declared here (flagged) so a v4 deployment is a one-line switch of API_VERSION.
// VERIFY against a live TheHive before trusting either — see README (v4 vs v5).
// =============================================================================

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_THEHIVE_PORT = 9000

/** TheHive REST paths per major version. `PRIMARY` is what handlers use. */
export const THEHIVE_PATHS = {
  // TheHive 5 (StrangeBee) — the primary target.
  v5: {
    caseTemplate: '/api/v1/caseTemplate',
    caseTemplateById: (id: string) => `/api/v1/caseTemplate/${encodeURIComponent(id)}`,
    query: '/api/v1/query',
    currentUser: '/api/v1/user/current',
  },
  // TheHive 4 (legacy) — flagged alternate; verify against a live TheHive 4.
  v4: {
    caseTemplate: '/api/case/template',
    caseTemplateById: (id: string) => `/api/case/template/${encodeURIComponent(id)}`,
    search: '/api/case/template/_search',
    currentUser: '/api/v1/user/current',
  },
} as const

/** Switch to 'v4' only for a legacy TheHive 4 deployment (see README). */
export const API_VERSION: 'v5' | 'v4' = 'v5'
export const PRIMARY = THEHIVE_PATHS[API_VERSION]

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** REST base for the TheHive web UI / API. Prefers an explicit URL. */
export function buildThehiveUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = Number(component.port) || DEFAULT_THEHIVE_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/**
 * TheHive authorization header — the API key as a Bearer token. Returns an empty
 * object when no key is present so callers can require a credential before
 * applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  return {}
}

export interface ThehiveResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One request that tolerates TheHive's (often self-signed) TLS. Dispatches on the
 * URL protocol: an explicit http:// endpoint uses node:http, otherwise node:https
 * with rejectUnauthorized:false. `Accept: application/json` is defaulted.
 */
export function thehiveRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<ThehiveResponse> {
  const u = new URL(url)
  const isHttp = u.protocol === 'http:'
  const send = isHttp ? httpRequest : httpsRequest
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = send(
      {
        hostname: u.hostname,
        port: u.port || (isHttp ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        ...(isHttp ? {} : { rejectUnauthorized: false }), // TheHive commonly ships self-signed certs
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
  const res = await thehiveRequest(url, { headers, timeoutMs })
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
  const res = await thehiveRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}

/**
 * List every case template (best-effort). v5 uses the query API
 * (POST /api/v1/query { query: [{ _name: 'listCaseTemplate' }] }); v4 uses
 * POST /api/case/template/_search. Kept here so the version seam stays in one file.
 */
export async function listCaseTemplates<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  if (API_VERSION === 'v5') {
    const url = `${base}${THEHIVE_PATHS.v5.query}?name=listCaseTemplate`
    return sendJson<T[]>('POST', url, headers, { query: [{ _name: 'listCaseTemplate' }] })
  }
  return sendJson<T[]>('POST', `${base}${THEHIVE_PATHS.v4.search}`, headers, { query: {}, range: 'all' })
}
