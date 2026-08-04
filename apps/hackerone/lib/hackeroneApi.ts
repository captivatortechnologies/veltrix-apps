// =============================================================================
// HackerOne API client.
//
// HackerOne exposes a SINGLE, cloud-hosted REST API at a FIXED base URL —
//   https://api.hackerone.com/v1
// There is no per-tenant hostname; every customer reaches the same host. The
// base is therefore a constant here (the connection endpoint is ignored).
//   Confirmed: https://api.hackerone.com/getting-started/
//
// Auth is HTTP Basic: the API token's IDENTIFIER is the username and the token
// VALUE is the password —
//   Authorization: Basic base64(<API username>:<API token>)
// The identifier is stored on the connection credential's `username`; the token
// value on `apiToken` (falling back to `password`). Both are required.
//   Confirmed: https://api.hackerone.com/getting-started/  and the reference
//   client github/hackerone-client (Faraday basic-auth token_name:token).
//
// Responses are JSON:API — a single resource is `{ data: { id, type, attributes } }`
// and a collection is `{ data: [ ... ], links: { next } }`. Writes send a JSON:API
// document `{ data: { type, attributes } }`.
//   Confirmed shape: https://api.hackerone.com/customer-resources/
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status` / `ok` / `json`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

/** The fixed, well-known HackerOne API base URL (v1). */
export const HACKERONE_BASE_URL = 'https://api.hackerone.com/v1'

export interface HackeroneSettings {
  timeoutMs: number
}

/** Resolve request settings from the app settings. */
export function readHackeroneSettings(settings: Record<string, unknown>): HackeroneSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

export interface HackeroneAuth {
  username: string
  token: string
}

/**
 * Extract the HackerOne Basic-auth pair from a Veltrix credential: the API
 * identifier (`username`) and the token value (`apiToken`, falling back to
 * `password`). Returns null when either half is missing — both are required.
 */
export function resolveHackeroneAuth(credential: CredentialRef | null): HackeroneAuth | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  if (!username || !token) return null
  return { username, token }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No HackerOne API credential — HackerOne authenticates with HTTP Basic using your API ' +
  'token identifier as the username and the token value as the password. Create a token in ' +
  'HackerOne (Organization Settings > API Tokens), then store the identifier in the connection ' +
  'credential’s "API username" field and the token value in the "API token" field.'

/** A JSON:API resource object. */
export interface JsonApiResource<A = Record<string, unknown>> {
  id?: string
  type?: string
  attributes?: A
  relationships?: Record<string, unknown>
}

/** A JSON:API document envelope (single resource or collection). */
export interface JsonApiDoc<A = Record<string, unknown>> {
  data?: JsonApiResource<A> | JsonApiResource<A>[]
  links?: { next?: string; prev?: string; self?: string }
  errors?: Array<{ status?: string; title?: string; detail?: string; code?: string }>
}

/** A parsed HackerOne API response. `json` is the parsed body (null when absent/invalid). */
export interface HackeroneResponse {
  status: number
  ok: boolean
  json: unknown
  body: string
}

export type HackeroneMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class HackerOneClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl?: string; username: string; token: string; timeoutMs: number }) {
    this.baseUrl = (opts.baseUrl ?? HACKERONE_BASE_URL).replace(/\/+$/, '')
    this.authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.token}`).toString('base64')}`
    this.timeoutMs = opts.timeoutMs
  }

  /** Low-level request against an API `path` (e.g. `/me/programs`). Never throws on non-2xx. */
  async request(
    method: HackeroneMethod,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<HackeroneResponse> {
    const url = this.buildUrl(path, opts.query)
    return this.fetchUrl(method, url, opts.body)
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async fetchUrl(method: HackeroneMethod, url: string, body: unknown): Promise<HackeroneResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      let json: unknown = null
      if (text) {
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
      }
      return { status: res.status, ok: res.status >= 200 && res.status < 300, json, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  get(path: string, query?: Record<string, string | number | undefined>): Promise<HackeroneResponse> {
    return this.request('GET', path, { query })
  }
  post(path: string, body: unknown): Promise<HackeroneResponse> {
    return this.request('POST', path, { body })
  }
  put(path: string, body: unknown): Promise<HackeroneResponse> {
    return this.request('PUT', path, { body })
  }
  delete(path: string): Promise<HackeroneResponse> {
    return this.request('DELETE', path)
  }

  /**
   * GET every page of a JSON:API collection, following `links.next` (absolute
   * URLs). Returns the flattened `data` resources. Best-effort — stops on the
   * first non-OK page and returns whatever was collected so far.
   */
  async getAll<A = Record<string, unknown>>(
    path: string,
    query: Record<string, string | number | undefined> = {},
  ): Promise<{ ok: boolean; items: JsonApiResource<A>[]; status: number; body: string }> {
    const items: JsonApiResource<A>[] = []
    let res = await this.get(path, { 'page[size]': 100, ...query })
    let lastStatus = res.status
    let lastBody = res.body
    const maxPages = 100
    for (let page = 0; page < maxPages; page++) {
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const doc = res.json as JsonApiDoc<A> | null
      const data = doc?.data
      if (Array.isArray(data)) items.push(...data)
      const next = doc?.links?.next
      if (!next) break
      res = await this.get(next)
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  /**
   * List the programs the credential can see (GET /me/programs). Each resource's
   * `attributes.handle` is the program handle used to select a program.
   *   Confirmed: https://api.hackerone.com/customer-resources/ (Get Your Programs)
   */
  listPrograms(): Promise<{ ok: boolean; items: JsonApiResource<{ handle?: string; name?: string }>[]; status: number; body: string }> {
    return this.getAll<{ handle?: string; name?: string }>('/me/programs')
  }

  /**
   * List the organizations the credential can see (GET /me/organizations). Each
   * resource's `attributes.handle` is the organization handle used to select an
   * organization — the same shape as `listPrograms`, one level up. Used by the
   * org-scoped Assets / Asset Scopes config types (the confirmed, non-deprecated
   * successor to the program-level structured-scope write endpoints).
   *   Confirmed: https://api.hackerone.com/customer-resources/ (Get Your Organizations)
   */
  listOrganizations(): Promise<{ ok: boolean; items: JsonApiResource<{ handle?: string }>[]; status: number; body: string }> {
    return this.getAll<{ handle?: string }>('/me/organizations')
  }

  /**
   * Connectivity / health probe: fetch the first page of the caller's programs.
   * 2xx = the Basic-auth pair is valid; 401 = bad identifier/token.
   */
  health(): Promise<HackeroneResponse> {
    return this.get('/me/programs', { 'page[size]': 1 })
  }
}

/** Build a client from the credential + settings. Returns `{ error }` when the credential is incomplete. */
export function buildHackeroneClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: HackerOneClient; baseUrl: string } | { error: string } {
  const auth = resolveHackeroneAuth(credential)
  if (!auth) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readHackeroneSettings(settings)
  return {
    client: new HackerOneClient({ username: auth.username, token: auth.token, timeoutMs: resolved.timeoutMs }),
    baseUrl: HACKERONE_BASE_URL,
  }
}

/** Human-readable message from a HackerOne JSON:API error response. Never throws. */
export function hackeroneErrorMessage(res: HackeroneResponse): string {
  const doc = res.json as JsonApiDoc | null
  if (doc && Array.isArray(doc.errors) && doc.errors.length > 0) {
    return doc.errors.map((e) => e.detail || e.title || e.code || 'error').join('; ')
  }
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

/**
 * Inspect a write response and return an error message when HackerOne rejected it,
 * or null on success. NON-UNION `string | null` (the platform handler loader
 * cannot narrow discriminated unions).
 */
export function hackeroneWriteError(res: HackeroneResponse): string | null {
  if (!res.ok) return hackeroneErrorMessage(res)
  return null
}
