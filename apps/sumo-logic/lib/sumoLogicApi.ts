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
// Docs (verified 2026-08-01, expanded 2026-08-04):
//   - Auth: https://help.sumologic.com/docs/api/about-apis/getting-started/
//   - Access keys: https://help.sumologic.com/docs/manage/security/access-keys/
//   - FER API: https://www.sumologic.com/help/docs/api/field-extraction-rules/
//   - Full OpenAPI spec (source of truth for every config type in this app):
//     https://api.sumologic.com/docs/sumologic-api.yaml
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

/**
 * Management API base URL for a connection. Prefers an explicit HTTPS URL.
 * Defaults to the `/api/v1` base; pass `apiVersion: 'v2'` for the config types
 * that live under `/api/v2` (Ingest Budgets, Content folders, Dashboards, …).
 */
export function buildBaseUrl(
  component: ComponentRef | null,
  connectivity: ConnectivityRef | null,
  apiVersion: 'v1' | 'v2' = 'v1',
): string {
  const raw = connectivity?.httpsUrl || component?.hostname || ''
  const v1 = normalizeBaseUrl(raw)
  if (!v1 || apiVersion === 'v1') return v1
  return v1.replace(/\/api\/v1$/, '/api/v2')
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

/** The `{ data: [...], next }` envelope most Sumo Logic paged list endpoints return. */
export type PagedEnvelope<T> = Record<string, unknown> & {
  data?: T[]
  next?: string | null
}

/**
 * Read every page of a paged Management API list endpoint and return the
 * flattened records. Pages via a continuation token (`?limit=<n>&token=<cursor>`),
 * guarded by a page cap so a malformed token can never loop forever. Sumo
 * Logic is NOT consistent about the envelope's field names across endpoints —
 * most use `{ data, next }` (the defaults below), but Data Forwarding uses
 * `{ data, nextToken }`, Dashboards uses `{ dashboards, next }`, and Log
 * Searches uses `{ logSearches, token }`. Pass `dataField`/`nextTokenField` to
 * match whichever shape the endpoint being read actually uses.
 *   Pagination shapes verified against the SumoLogic terraform provider and
 *   the official OpenAPI spec (api.sumologic.com/docs/sumologic-api.yaml).
 */
export async function listPaged<T>(
  base: string,
  resource: string,
  headers: Record<string, string>,
  opts: { pageSize?: number; maxPages?: number; timeoutMs?: number; dataField?: string; nextTokenField?: string } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000
  const maxPages = opts.maxPages ?? 100
  const dataField = opts.dataField ?? 'data'
  const tokenField = opts.nextTokenField ?? 'next'
  const out: T[] = []
  let url = `${base}/${resource}?limit=${pageSize}`
  for (let page = 0; page < maxPages; page++) {
    const env = await getJson<PagedEnvelope<T>>(url, headers, opts.timeoutMs)
    const pageData = env?.[dataField]
    if (Array.isArray(pageData)) out.push(...(pageData as T[]))
    const next = env?.[tokenField] as string | null | undefined
    if (!next) break
    // The request query parameter is always `token=`, regardless of which field name the response uses for it.
    url = `${base}/${resource}?limit=${pageSize}&token=${encodeURIComponent(next)}`
  }
  return out
}

/** Status envelope returned by Sumo Logic's asynchronous Content Management jobs. */
export interface AsyncJobStatus {
  status: 'InProgress' | 'Success' | 'Failed' | string
  statusMessage?: string
  error?: { message?: string; code?: string }
}

/**
 * Poll a Sumo Logic asynchronous job status URL (Content Management folder
 * delete/copy/export jobs return a `{ id }` job handle, not an immediate
 * result) until it leaves `InProgress`, or a timeout elapses. Used by the
 * Content folders config type, whose delete is job-based rather than
 * synchronous.
 *   API: https://help.sumologic.com/docs/api/content-management/
 */
export async function pollAsyncJob(
  statusUrl: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<AsyncJobStatus> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const intervalMs = opts.intervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  let last: AsyncJobStatus = { status: 'InProgress' }
  for (;;) {
    last = await getJson<AsyncJobStatus>(statusUrl, headers)
    if (last.status !== 'InProgress') return last
    if (Date.now() >= deadline) {
      return { status: 'Failed', statusMessage: `Timed out after ${timeoutMs / 1000}s waiting for the job to finish.` }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Deep, key-order-independent JSON serialization. Used by the config types
 * that author nested structures (queries/triggers/notifications on Monitors,
 * panels/layout on Dashboards) as JSON blobs, to compare live vs. declared
 * state for drift detection without false positives from object key ordering.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
