// =============================================================================
// Rubrik CDM (Cloud Data Management) access seam.
//
// One path: HTTPS REST against a Rubrik cluster. A Rubrik cluster commonly ships
// a self-signed certificate, so the transport accepts untrusted certs (same
// posture as MISP's mispApi / security-onion's soConsole) via node:https with
// rejectUnauthorized:false — flip on with the `verify_tls` app setting.
//
// Auth is a two-step SERVICE-ACCOUNT session:
//   1. POST /api/v1/service_account/session  { serviceAccountId, secret }  -> { token }
//   2. Authorization: Bearer <token>  on every subsequent call
// The serviceAccountId is stored in the connection credential's `username`, the
// secret in its `apiToken` (falling back to `password`).
//
// Base URL is the cluster origin, e.g. https://rubrik.example.com — endpoints
// carry their own /api/v1 or /api/v2 prefix.
//
// NOTE: API shapes here follow Rubrik CDM 8.x REST conventions
// (/api/v1/service_account/session, /api/v1/cluster/me, /api/v2/sla_domain).
// Verify against a live Rubrik CDM cluster.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** Default per-request timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 15_000

export interface RubrikResponse {
  status: number
  ok: boolean
  body: string
}

export interface RubrikSettings {
  /** Enforce a valid TLS certificate on the cluster endpoint. Off by default. */
  verifyTls: boolean
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
}

/** Read and normalize the app settings that drive Rubrik access. */
export function readRubrikSettings(settings: Record<string, unknown> | undefined): RubrikSettings {
  const verifyTls = settings?.verify_tls === true
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS
  return { verifyTls, timeoutMs }
}

/**
 * Cluster origin base URL (no trailing slash), derived from the component
 * hostname the Connection stored. Accepts a bare host or a full URL and
 * normalizes to https://<host>.
 */
export function buildRubrikBaseUrl(component: Pick<ComponentRef, 'hostname' | 'port'>): string | null {
  const raw = (component.hostname || '').trim()
  if (!raw) return null
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  const url = withScheme.replace(/\/+$/, '')
  // A component port only matters when the host carried none of its own.
  const port = component.port ? String(component.port).trim() : ''
  if (port && port !== '443' && !/:\d+$/.test(new URL(withScheme).host)) {
    return `${url}:${port}`
  }
  return url
}

export interface RubrikServiceAccount {
  serviceAccountId: string
  secret: string
}

/**
 * Extract the service-account credentials from a Veltrix credential.
 * Convention: service account id in `username`, secret in `apiToken`
 * (falling back to `password`).
 */
export function resolveServiceAccount(credential: CredentialRef | null): RubrikServiceAccount | null {
  if (!credential) return null
  const serviceAccountId = credential.username?.trim()
  const secret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!serviceAccountId || !secret) return null
  return { serviceAccountId, secret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Rubrik service-account credentials available — store the service account id in the ' +
  'credential "username" field and its secret in the "API token" field (create a service ' +
  'account under Settings > Users & Roles > Service Accounts in the Rubrik cluster).'

/** One HTTPS request that tolerates a Rubrik cluster's self-signed certificate. */
export function rubrikRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
    verifyTls?: boolean
  } = {},
): Promise<RubrikResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
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

/** Bearer authorization header for an established Rubrik session. */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

interface ServiceAccountSessionResponse {
  token?: string
  session?: { token?: string }
}

/**
 * Exchange service-account credentials for a session token.
 * POST /api/v1/service_account/session { serviceAccountId, secret } -> { token }.
 * Verify against a live Rubrik CDM cluster.
 */
export async function createServiceAccountSession(
  base: string,
  account: RubrikServiceAccount,
  opts: { verifyTls?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const res = await rubrikRequest(`${base}/api/v1/service_account/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceAccountId: account.serviceAccountId, secret: account.secret }),
    verifyTls: opts.verifyTls,
    timeoutMs: opts.timeoutMs,
  })
  if (!res.ok) {
    throw new Error(`Service-account session failed → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  }
  const parsed = safeJson<ServiceAccountSessionResponse>(res.body)
  const token = parsed?.token ?? parsed?.session?.token
  if (!token) throw new Error('Service-account session succeeded but no token was returned.')
  return token
}

export interface RubrikConnection {
  base: string
  headers: Record<string, string>
  settings: RubrikSettings
}

/**
 * Resolve the cluster base URL + credential, open a service-account session, and
 * return a ready-to-use { base, headers } for the handlers. Throws a clear
 * message when the endpoint or credential is missing so callers can surface it.
 */
export async function rubrikConnect(
  component: Pick<ComponentRef, 'hostname' | 'port'>,
  credential: CredentialRef | null,
  rawSettings: Record<string, unknown> | undefined,
): Promise<RubrikConnection> {
  const base = buildRubrikBaseUrl(component)
  if (!base) throw new Error('No cluster endpoint is configured for this connection.')
  const account = resolveServiceAccount(credential)
  if (!account) throw new Error(MISSING_CREDENTIAL_MESSAGE)
  const settings = readRubrikSettings(rawSettings)
  const token = await createServiceAccountSession(base, account, {
    verifyTls: settings.verifyTls,
    timeoutMs: settings.timeoutMs,
  })
  return { base, headers: authHeader(token), settings }
}

/** GET JSON, throwing on a non-2xx response. */
export async function getJson<T>(
  conn: RubrikConnection,
  path: string,
  timeoutMs?: number,
): Promise<T> {
  const res = await rubrikRequest(`${conn.base}${path}`, {
    headers: conn.headers,
    verifyTls: conn.settings.verifyTls,
    timeoutMs: timeoutMs ?? conn.settings.timeoutMs,
  })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return safeJson<T>(res.body) ?? ({} as T)
}

/** Send JSON (POST/PATCH/PUT/DELETE), throwing on a non-2xx response. */
export async function sendJson<T>(
  conn: RubrikConnection,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await rubrikRequest(`${conn.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...conn.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    verifyTls: conn.settings.verifyTls,
    timeoutMs: timeoutMs ?? conn.settings.timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? safeJson<T>(res.body) : ({} as T)) ?? ({} as T)
}

/** Parse JSON, returning null on malformed content instead of throwing. */
export function safeJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}
