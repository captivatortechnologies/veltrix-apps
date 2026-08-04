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
//
// The v0.4.0 config types (organisations, profiles, page templates) add three
// more nuances to the seam, confirmed against the official TheHive 4 OpenAPI
// spec (github.com/TheHive-Project/api-docs, thehive.yaml) alongside thehive4py:
//   - organisation: create/update share the SAME /api/v1/organisation path on
//     BOTH versions (TheHive 4 grew a v1 organisation surface late in its life);
//     only the LIST mechanism differs (v5 query API vs v4's legacy
//     /api/v0/organisation collection GET).
//   - profile: full CRUD, but on DIFFERENT versioned paths — v5 is
//     /api/v1/profile, v4 is /api/v0/profile (confirmed, not flagged).
//   - pageTemplate (Knowledge Base): a TheHive 5-ONLY feature, confirmed absent
//     from the TheHive 4 spec — it bypasses this seam entirely (see
//     PAGE_TEMPLATE_PATHS_V5 below) rather than pretending a v4 path exists.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_THEHIVE_PORT = 9000

/**
 * TheHive REST paths per major version. `PRIMARY` is what handlers use.
 *
 * NOTE ON THE SEAM: `PRIMARY = THEHIVE_PATHS[API_VERSION]` where API_VERSION is a
 * `'v5' | 'v4'` union, so TypeScript only exposes keys present on BOTH versions.
 * Every path a handler reaches for via `PRIMARY.*` must therefore be declared in
 * v5 AND v4 (v4 values are the flagged legacy alternate — verify against a live
 * TheHive 4). The v5-only list plumbing (`query`) stays inside the list helpers.
 */
export const THEHIVE_PATHS = {
  // TheHive 5 (StrangeBee) — the primary target.
  v5: {
    caseTemplate: '/api/v1/caseTemplate',
    caseTemplateById: (id: string) => `/api/v1/caseTemplate/${encodeURIComponent(id)}`,
    // Custom fields — CRUD, list is a plain GET on the collection (no query API).
    customField: '/api/v1/customField',
    customFieldById: (id: string) => `/api/v1/customField/${encodeURIComponent(id)}`,
    // Observable types — create/get/delete only (no update endpoint in v5).
    observableType: '/api/v1/observable/type',
    observableTypeById: (id: string) => `/api/v1/observable/type/${encodeURIComponent(id)}`,
    // Users — create/get/update; delete is the /force variant.
    user: '/api/v1/user',
    userById: (id: string) => `/api/v1/user/${encodeURIComponent(id)}`,
    userDelete: (id: string) => `/api/v1/user/${encodeURIComponent(id)}/force`,
    // Organisations — create/update (no delete endpoint — see organisations
    // config type; deploy is create/update-only, rollback of a create locks
    // rather than deletes). List goes through the query API (listOrganisation).
    organisation: '/api/v1/organisation',
    organisationById: (id: string) => `/api/v1/organisation/${encodeURIComponent(id)}`,
    // Profiles (RBAC) — full CRUD, real delete.
    profile: '/api/v1/profile',
    profileById: (id: string) => `/api/v1/profile/${encodeURIComponent(id)}`,
    profileDelete: (id: string) => `/api/v1/profile/${encodeURIComponent(id)}`,
    query: '/api/v1/query',
    currentUser: '/api/v1/user/current',
  },
  // TheHive 4 (legacy) — flagged alternate; verify against a live TheHive 4.
  v4: {
    caseTemplate: '/api/case/template',
    caseTemplateById: (id: string) => `/api/case/template/${encodeURIComponent(id)}`,
    // FLAGGED (unverified against TheHive 4): legacy un-versioned collection paths.
    customField: '/api/customField',
    customFieldById: (id: string) => `/api/customField/${encodeURIComponent(id)}`,
    observableType: '/api/observable/type',
    observableTypeById: (id: string) => `/api/observable/type/${encodeURIComponent(id)}`,
    user: '/api/user',
    userById: (id: string) => `/api/user/${encodeURIComponent(id)}`,
    userDelete: (id: string) => `/api/user/${encodeURIComponent(id)}`,
    search: '/api/case/template/_search',
    // Organisations — CONFIRMED (TheHive 4 OpenAPI): create/update already lived
    // at /api/v1/organisation before the v5 fork. Only list is v0-only (below).
    organisation: '/api/v1/organisation',
    organisationById: (id: string) => `/api/v1/organisation/${encodeURIComponent(id)}`,
    // v0-only: the legacy collection GET used for listing (see listOrganisations).
    // Not part of PRIMARY (v5 has no v0 counterpart) — same pattern as `search`.
    organisationListV0: '/api/v0/organisation',
    // Profiles — CONFIRMED (TheHive 4 OpenAPI): full CRUD, but on /api/v0
    // (the versioned /api/v1/profile only exists in TheHive 5).
    profile: '/api/v0/profile',
    profileById: (id: string) => `/api/v0/profile/${encodeURIComponent(id)}`,
    profileDelete: (id: string) => `/api/v0/profile/${encodeURIComponent(id)}`,
    currentUser: '/api/v1/user/current',
  },
} as const

/**
 * Page Templates (Knowledge Base) — a TheHive 5-ONLY feature. Confirmed absent
 * from the TheHive 4 OpenAPI spec (github.com/TheHive-Project/api-docs) and from
 * thehive4py's TheHive4-era history, so — unlike every other path above — there
 * is no v4 alternate to declare. This deliberately bypasses the THEHIVE_PATHS /
 * PRIMARY seam: page-templates handlers import this directly and check
 * `isPageTemplateSupported()` before calling out, rather than pretending a v4
 * path exists. See README (Page Templates — v5 only).
 */
export const PAGE_TEMPLATE_PATHS_V5 = {
  pageTemplate: '/api/v1/pageTemplate',
  pageTemplateById: (id: string) => `/api/v1/pageTemplate/${encodeURIComponent(id)}`,
} as const

/** True when the active seam target is TheHive 5 — the only version Page Templates exist on. */
export function isPageTemplateSupported(): boolean {
  return API_VERSION === 'v5'
}

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

/**
 * v5 list over the query API: POST /api/v1/query { query: [{ _name }] }. The
 * `name` query param is TheHive's telemetry label (thehive4py sets it too). Kept
 * here so the version seam and the exact `_name` operations live in one file.
 */
function queryListV5<T>(base: string, headers: Record<string, string>, name: string): Promise<T[]> {
  const url = `${base}${THEHIVE_PATHS.v5.query}?name=${encodeURIComponent(name)}`
  return sendJson<T[]>('POST', url, headers, { query: [{ _name: name }] })
}

/**
 * List custom fields. v5 exposes a plain collection GET (no query API); v4 uses
 * the legacy un-versioned collection (flagged — verify against a live TheHive 4).
 */
export async function listCustomFields<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  return getJson<T[]>(`${base}${PRIMARY.customField}`, headers)
}

/** List observable types. v5 → query `listObservableType`; v4 → legacy GET (flagged). */
export async function listObservableTypes<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  if (API_VERSION === 'v5') return queryListV5<T>(base, headers, 'listObservableType')
  return getJson<T[]>(`${base}${THEHIVE_PATHS.v4.observableType}`, headers)
}

/** List users (current organisation). v5 → query `listUser`; v4 → legacy GET (flagged). */
export async function listUsers<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  if (API_VERSION === 'v5') return queryListV5<T>(base, headers, 'listUser')
  return getJson<T[]>(`${base}${THEHIVE_PATHS.v4.user}`, headers)
}

/**
 * List organisations. v5 → query `listOrganisation`; v4 → the legacy
 * /api/v0/organisation collection GET (CONFIRMED via the TheHive 4 OpenAPI spec).
 */
export async function listOrganisations<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  if (API_VERSION === 'v5') return queryListV5<T>(base, headers, 'listOrganisation')
  return getJson<T[]>(`${base}${THEHIVE_PATHS.v4.organisationListV0}`, headers)
}

/**
 * List profiles. v5 → query `listProfile`; v4 → a plain GET on the /api/v0/profile
 * collection (CONFIRMED via the TheHive 4 OpenAPI spec — the same path PRIMARY
 * uses for create, since v4's profile collection doubles as its list).
 */
export async function listProfiles<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  if (API_VERSION === 'v5') return queryListV5<T>(base, headers, 'listProfile')
  return getJson<T[]>(`${base}${PRIMARY.profile}`, headers)
}

/**
 * List page templates (v5-only — see PAGE_TEMPLATE_PATHS_V5). Always uses the v5
 * query API regardless of API_VERSION; callers must gate on isPageTemplateSupported()
 * first.
 */
export async function listPageTemplates<T>(base: string, headers: Record<string, string>): Promise<T[]> {
  return queryListV5<T>(base, headers, 'listPageTemplate')
}
