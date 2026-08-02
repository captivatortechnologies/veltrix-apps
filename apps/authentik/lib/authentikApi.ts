// =============================================================================
// authentik Core API access seam.
//
// One path: HTTPS REST against the authentik server's own host. authentik is
// commonly self-hosted, so the transport tolerates an untrusted/self-signed
// certificate via node:https with rejectUnauthorized:false unless the
// `verify_tls` setting is explicitly on (same posture as keycloak's
// keycloakApi / misp's mispApi).
//
// Base URL:  https://<host>[:port]/api/v3/
// Auth:      Authorization: Bearer <token>  — the `authentik` OpenAPI security
//            scheme is `{ type: http, scheme: bearer }`. This is a STATIC API
//            token (Directory > Tokens, or a Service Account's token) — no
//            token exchange, no expiry handled by this client.
//
// Identity:  the `applications` resource is keyed on its `slug` — authentik
//            exposes a true retrieve-by-identity endpoint
//            (GET/PUT/PATCH/DELETE /core/applications/{slug}/), so callers can
//            check existence directly instead of listing + matching by name.
//
// Pagination: authentik wraps DRF list responses as
//   { pagination: { next, previous, count, current, total_pages, start_index,
//                    end_index }, results: [...], autocomplete: {...} }
// where `pagination.next` / `.previous` are PAGE NUMBERS (or a falsy value at
// the start/end of the set) — NOT next-page URLs like plain DRF's default
// PageNumberPagination. `listAll` below pages via the numeric `page` query
// param until `pagination.next` is falsy.
//
// Cited & verified against the official OpenAPI v3 schema
// (https://api.goauthentik.io/schema.yml — mirrored from the live instance's
// own https://<host>/api/v3/schema/) and its rendered reference
// (https://docs.goauthentik.io/developer-docs/api/ → api.goauthentik.io):
//   - Auth scheme:  api.goauthentik.io/authentication/ (bearer token; the API
//                   browser is documented at https://<host>/api/v3/)
//   - Applications: api.goauthentik.io/reference/core-applications-list,
//                   core-applications-create, core-applications-retrieve,
//                   core-applications-partial-update, core-applications-destroy
//   - Schemas:      `Application`, `ApplicationRequest`, `PatchedApplicationRequest`,
//                   `PaginatedApplicationList`, `Pagination` (components.schemas
//                   in schema.yml)
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_AUTHENTIK_PORT = 443
/** The authentik REST API is versioned under this fixed path segment. */
export const API_BASE_PATH = '/api/v3'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the authentik server (no trailing slash, no `/api/v3` path). Prefers an explicit URL. */
export function buildAuthentikUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = Number(component.port) || DEFAULT_AUTHENTIK_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/** Normalize a raw host/endpoint (with or without a scheme) into an https base URL, no trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** `<base>/api/v3` — the authentik REST API base (no trailing slash). */
export function buildApiBase(base: string): string {
  return `${base.replace(/\/+$/, '')}${API_BASE_PATH}`
}

/** Enforce a valid TLS certificate only when the `verify_tls` setting is explicitly true. */
export function resolveVerifyTls(settings: Record<string, unknown> | undefined): boolean {
  return settings?.verify_tls === true
}

/** Pull the static API token out of a stored credential (the `apiToken` field). No username is used. */
export function resolveApiToken(credential: CredentialRef | null | undefined): string | null {
  const token = credential?.apiToken?.trim()
  return token ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No authentik API token — create one in authentik (Directory > Tokens, or as a Service ' +
  "account's token) with permission to manage applications, then store it in the credential " +
  '"API token" field.'

export const MISSING_ENDPOINT_MESSAGE =
  'No authentik endpoint — register an "authentik-server" component whose hostname is your ' +
  'authentik instance (e.g. authentik.example.com).'

export interface AuthentikResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that (by default) tolerates a self-signed certificate — a
 * freshly self-hosted authentik instance commonly runs behind one until a real
 * cert is issued. Uses node:https directly so the platform's global fetch
 * settings don't reject the untrusted cert. Never throws on an HTTP error status.
 */
export function authentikRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
    verifyTls?: boolean
  } = {},
): Promise<AuthentikResponse> {
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
        rejectUnauthorized: init.verifyTls === true, // self-signed tolerated unless verify_tls
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

export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** `Authorization: Bearer <token>` header for a static authentik API token. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

interface RequestOpts {
  timeoutMs?: number
  verifyTls?: boolean
}

export async function getJson<T>(url: string, token: string, opts: RequestOpts = {}): Promise<T> {
  const res = await authentikRequest(url, { headers: bearer(token), timeoutMs: opts.timeoutMs, verifyTls: opts.verifyTls })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return parseJson<T>(res.body) ?? ({} as T)
}

/** GET a resource by identity; returns `null` on a 404 instead of throwing — an existence check. */
export async function getJsonOrNull<T>(url: string, token: string, opts: RequestOpts = {}): Promise<T | null> {
  const res = await authentikRequest(url, { headers: bearer(token), timeoutMs: opts.timeoutMs, verifyTls: opts.verifyTls })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return parseJson<T>(res.body)
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  body?: unknown,
  opts: RequestOpts = {},
): Promise<T> {
  const res = await authentikRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: opts.timeoutMs,
    verifyTls: opts.verifyTls,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return res.body ? (parseJson<T>(res.body) ?? ({} as T)) : ({} as T)
}

/** DELETE a resource. authentik returns 204 No Content on success; a 404 is tolerated as already-gone. */
export async function deleteResource(url: string, token: string, opts: RequestOpts = {}): Promise<void> {
  const res = await authentikRequest(url, { method: 'DELETE', headers: bearer(token), timeoutMs: opts.timeoutMs, verifyTls: opts.verifyTls })
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
}

// --- Pagination ----------------------------------------------------------------

/** authentik's custom pagination envelope. `next`/`previous` are PAGE NUMBERS, not URLs. */
export interface AuthentikPagination {
  next: number | null
  previous: number | null
  count: number
  current: number
  total_pages: number
  start_index: number
  end_index: number
}

export interface AuthentikPaginatedResponse<T> {
  pagination: AuthentikPagination
  results: T[]
}

/** Append/override query params on a URL that may already carry some. */
export function appendQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url)
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value)
  return u.toString()
}

/**
 * Page through an authentik list endpoint, concatenating `results`. Increments
 * the numeric `page` query param until `pagination.next` is falsy (authentik
 * reports the NEXT PAGE NUMBER there, not a link — see the module docs above).
 * `listUrl` should already include any filter query params (e.g. `search=`);
 * `page`/`page_size` are added/overwritten here.
 */
export async function listAll<T>(
  listUrl: string,
  token: string,
  opts: RequestOpts & { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 100
  const maxPages = opts.maxPages ?? 100
  const results: T[] = []
  let page = 1
  for (let i = 0; i < maxPages; i++) {
    const url = appendQuery(listUrl, { page: String(page), page_size: String(pageSize) })
    const data = await getJson<AuthentikPaginatedResponse<T>>(url, token, opts)
    if (Array.isArray(data.results)) results.push(...data.results)
    const next = data.pagination?.next
    if (!next || next === page) break
    page = next
  }
  return results
}

/**
 * Find a single resource by exact NAME match via the `name` query-string filter
 * (authentik's `QueryName` list parameter) — for resources whose API path key is
 * a server-assigned id/uuid rather than a user-declared identity (e.g. OAuth2/
 * OpenID Providers, Groups), so there is no direct retrieve-by-identity endpoint
 * the way Applications/Flows have (`.../{slug}/`). The `name` filter narrows
 * server-side; this still verifies exact equality client-side and returns the
 * first match, since authentik does not enforce name-uniqueness on every
 * resource. Returns `null` when nothing matches.
 */
export async function findByName<T extends { name?: string }>(
  listUrl: string,
  token: string,
  name: string,
  opts: RequestOpts = {},
): Promise<T | null> {
  const target = name.trim()
  if (!target) return null
  const url = appendQuery(listUrl, { name: target })
  const candidates = await listAll<T>(url, token, { ...opts, pageSize: 100, maxPages: 5 })
  return candidates.find((c) => (c.name ?? '').trim() === target) ?? null
}
