// =============================================================================
// runZero access seam.
//
// One path: HTTPS REST against the runZero console API. runZero is a SaaS with a
// fixed, publicly-trusted base URL — https://console.runzero.com/api/v1.0 — so
// unlike the self-hosted apps this uses the platform's global `fetch` (valid TLS,
// no self-signed tolerance) with an AbortController timeout, and never throws on
// an HTTP error status: callers inspect `status`/`ok` so they can tell a 404 from
// a real failure.
//
// Auth is a runZero Organization API key (OT… prefix) carried as a Bearer token:
// `Authorization: Bearer <token>`. The key is stored as the connection
// credential's apiToken. An Organization key is scoped to a single org and its
// org id is encoded in the token, so no org id has to be supplied separately.
//
// Docs: https://help.runzero.com/docs/leveraging-the-api/ and the OpenAPI spec at
// https://github.com/runZeroInc/runzero-api (runzero-api.yml).
// =============================================================================

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** The runZero hosted console — the default host for the API. */
export const DEFAULT_RUNZERO_HOST = 'console.runzero.com'
/** Versioned API path appended to the host. */
export const RUNZERO_API_PATH = '/api/v1.0'
export const DEFAULT_TIMEOUT_MS = 15_000

export const MISSING_CREDENTIAL_MESSAGE =
  'No runZero API key available — create an Organization API key in the runZero console ' +
  '(Account → API keys → Organization) and store it in the connection credential\'s "API key" ' +
  'field. The key must have write access to the target organization.'

type ProviderLike = { config?: Record<string, unknown> | null } | null

/**
 * Reduce a raw endpoint/host into a bare host: strips scheme, any trailing path
 * (including a copy-pasted /api/v1.0), and a trailing slash. Defaults to the
 * hosted console when nothing usable is supplied.
 */
export function normalizeHost(raw: string | null | undefined): string {
  let host = (raw ?? '').trim().toLowerCase()
  if (!host) return DEFAULT_RUNZERO_HOST
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')
  return host || DEFAULT_RUNZERO_HOST
}

/**
 * HTTPS base for the runZero console API (e.g.
 * `https://console.runzero.com/api/v1.0`). Prefers an explicit connectivity URL,
 * then the component hostname (the connection endpoint), then the hosted console.
 * A self-hosted runZero Platform install simply sets its own host as the endpoint.
 */
export function buildRunzeroUrl(
  component?: ComponentRef | null,
  connectivity?: ConnectivityRef | null,
  _provider?: ProviderLike,
): string {
  if (connectivity?.httpsUrl) {
    const trimmed = connectivity.httpsUrl.replace(/\/+$/, '')
    return /\/api\/v[\d.]+$/i.test(trimmed) ? trimmed : `${trimmed}${RUNZERO_API_PATH}`
  }
  const host = normalizeHost(component?.hostname)
  return `https://${host}${RUNZERO_API_PATH}`
}

/** Extract the runZero API key from a Veltrix credential ("API key" or "password"). */
export function resolveRunzeroToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

/**
 * runZero authorization headers. The API key is sent as a Bearer token. Returns an
 * empty object when no key is present — callers require a credential before
 * applying anything.
 */
export function buildAuthHeader(credential: CredentialRef | null): Record<string, string> {
  const token = resolveRunzeroToken(credential)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface RunzeroResponse {
  status: number
  ok: boolean
  body: string
}

export type RunzeroMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * One HTTPS request to the runZero console API. Uses global fetch (valid TLS) with
 * an AbortController timeout and never throws on an HTTP error status — the caller
 * inspects `status`/`ok`. `Accept`/`Content-Type: application/json` are defaulted.
 */
export async function runzeroRequest(
  url: string,
  init: { method?: RunzeroMethod; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<RunzeroResponse> {
  const controller = new AbortController()
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/**
 * Coerce a runZero list response into rows. runZero mostly returns a bare array,
 * but tolerate a `{ data: [...] }` envelope too. Shared by the org resource
 * config types (sites keeps its own copy for isolation; tasks/templates use this).
 */
export function coerceList<T>(list: unknown): T[] {
  if (Array.isArray(list)) return list as T[]
  if (list && typeof list === 'object' && Array.isArray((list as { data?: unknown }).data)) {
    return (list as { data: T[] }).data
  }
  return []
}

/** GET + parse JSON, throwing a readable error on a non-OK response. */
export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<T> {
  const res = await runzeroRequest(url, { headers, timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (parseJson<T>(res.body) ?? ({} as T))
}

/** Send a body-bearing request + parse JSON, throwing a readable error on failure. */
export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await runzeroRequest(url, { method, headers, body, timeoutMs })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (parseJson<T>(res.body) ?? ({} as T))
}
