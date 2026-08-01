// =============================================================================
// Sumo Logic access seam.
//
// One path: HTTPS REST against the Sumo Logic Management API. Sumo Logic is SaaS
// on the public internet with a valid TLS certificate, so this uses the platform's
// native `fetch` (no self-signed bypass, unlike the on-prem apps).
//
// Auth is HTTP Basic with an Access ID + Access Key pair
// (`Authorization: Basic base64(accessId:accessKey)`). The Access ID is stored as
// the connection credential's `username`; the Access Key is the write-only secret
// stored as the credential's `apiToken`.
//
// Base URL is per-deployment: `https://api.<deployment>.sumologic.com/api/v1/`
// (US1 = `api.sumologic.com`; other regions carry the deployment in the host,
// e.g. `api.us2.sumologic.com`, `api.eu.sumologic.com`, `api.au.sumologic.com`).
// The connection's endpoint carries the deployment host.
//
// Docs (verified 2026-08-01):
//   - Auth: https://help.sumologic.com/docs/api/about-apis/getting-started/
//   - Access keys: https://help.sumologic.com/docs/manage/security/access-keys/
//   - FER API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
// =============================================================================

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** The `/api/v1` suffix every Management API base URL ends with. */
const API_BASE_SUFFIX = '/api/v1'

/**
 * Normalize a raw deployment endpoint/host into the Management API base URL,
 * always ending at `/api/v1` (no trailing slash). Accepts a bare host
 * (`api.us2.sumologic.com`), a scheme-qualified host, or a URL that already
 * points at the `/api/vN` base.
 */
export function normalizeBaseUrl(raw: string): string {
  let s = String(raw ?? '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  s = s.replace(/\/+$/, '')
  if (/\/api\/v\d+$/i.test(s)) return s
  return `${s}${API_BASE_SUFFIX}`
}

/** Management API base URL (`…/api/v1`) for a connection. Prefers an explicit HTTPS URL. */
export function buildBaseUrl(component: ComponentRef | null, connectivity: ConnectivityRef | null): string {
  const raw = connectivity?.httpsUrl || component?.hostname || ''
  return normalizeBaseUrl(raw)
}

/**
 * HTTP Basic authorization header from the credential: Access ID (`username`) +
 * Access Key (`apiToken`). Returns an empty object when either half is missing —
 * callers require a complete credential before applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  const accessId = (credential.username ?? '').trim()
  const accessKey = (credential.apiToken ?? '').trim()
  if (!accessId || !accessKey) return {}
  const token = Buffer.from(`${accessId}:${accessKey}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** True when the credential carries both an Access ID and an Access Key. */
export function hasBasicAuth(credential: CredentialRef | null | undefined): boolean {
  return Boolean(credential && (credential.username ?? '').trim() && (credential.apiToken ?? '').trim())
}

export interface SumoResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request to the Sumo Logic Management API. Uses native `fetch` with an
 * abort-based timeout; Sumo serves valid public certificates so no TLS override is
 * needed. `Accept: application/json` is defaulted on every request.
 */
export async function sumoRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<SumoResponse> {
  const timeoutMs = init.timeoutMs ?? 15_000
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.text()
    return { status: res.status, ok: res.ok, body }
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${new URL(url).host}`)
    }
    throw err
  }
}

export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<T> {
  const res = await sumoRequest(url, { headers, timeoutMs })
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
  const res = await sumoRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
