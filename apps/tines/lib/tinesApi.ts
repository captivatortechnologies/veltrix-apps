// =============================================================================
// Tines REST API client.
//
// Base URL is PER-TENANT: `https://<tenant-domain>/api/v1/<endpoint>` — the
// tenant domain is a Veltrix component hostname (e.g. acme-tines.tines.com, a
// Cloud tenant, or a self-hosted domain). Auth is a Tines API key sent as
// `Authorization: Bearer <key>` on every request.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status — callers inspect `status`/`ok` so
// they can tell a 404 (object absent) from a real failure.
//
// Pagination is page-based (`?page=&per_page=`, max 500/page) with a `meta`
// envelope carrying `pages` (total page count) and `count` (total items);
// `getAll` pages until `meta.pages` is exhausted.
//
// Docs (fetched 2026-08-05):
//   https://www.tines.com/api/ (overview: base URL shape, pagination, auth)
//   https://www.tines.com/api/stories, /api/teams, /api/folders,
//   https://www.tines.com/api/resources, /api/credentials, /api/tags
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000
const MAX_PAGES = 50
export const DEFAULT_PER_PAGE = 200

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface TinesSettings {
  timeoutMs: number
}

export function readTinesSettings(settings: Record<string, unknown>): TinesSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Tines API key available — create one in the Tines web app (your name, top right ' +
  '> Team Settings, or a personal API key under your user menu) and store it in the ' +
  'credential\'s "API token" field. The app sends it as "Authorization: Bearer <key>".'

export const MISSING_COMPONENT_MESSAGE =
  'No Tines tenant registered for this connection yet — register a "tines-tenant" ' +
  'component whose hostname is your Tines tenant domain (e.g. acme.tines.com).'

/** Extract the Tines API key from a Veltrix credential ("API token" or "password"). */
export function resolveTinesToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export interface TinesResponse {
  status: number
  ok: boolean
  body: string
}

export type TinesMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class TinesClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { hostname: string; token: string; timeoutMs: number }) {
    // Normalize a bare tenant domain or a full URL to `https://<tenant>/api/v1`.
    const trimmed = opts.hostname.trim().replace(/\/+$/, '')
    const withScheme = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`
    this.baseUrl = /\/api\/v1$/.test(withScheme) ? withScheme : `${withScheme}/api/v1`
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  get apiBase(): string {
    return this.baseUrl
  }

  async request(
    method: TinesMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<TinesResponse> {
    let res = await this.send(method, path, opts)
    let attempts = 0
    while (res.status === 429 && attempts < 2) {
      const retryAfterMs = res.retryAfterMs
      if (retryAfterMs === null || retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) break
      await sleep(retryAfterMs > 0 ? retryAfterMs : 1000)
      res = await this.send(method, path, opts)
      attempts++
    }
    return { status: res.status, ok: res.ok, body: res.body }
  }

  /**
   * GET every page of a page-paginated collection (`?page=&per_page=`),
   * concatenating the array at `wrapperKey` (e.g. "teams", "stories"). Loops
   * until the response's `meta.pages` is exhausted or a page comes back empty.
   */
  async getAll<T = unknown>(
    path: string,
    wrapperKey: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let lastStatus = 0
    let lastBody = ''
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.request('GET', path, { query: { ...query, page, per_page: DEFAULT_PER_PAGE } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<Record<string, unknown>>(res.body)
      const chunk = env && Array.isArray(env[wrapperKey]) ? (env[wrapperKey] as T[]) : []
      items.push(...chunk)
      const meta = env?.meta as { pages?: number } | undefined
      if (chunk.length === 0 || (typeof meta?.pages === 'number' && page >= meta.pages)) break
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async send(
    method: TinesMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<TinesResponse & { retryAfterMs: number | null }> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      const ok = res.status >= 200 && res.status < 300
      const retryAfter = res.headers.get('retry-after')
      const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null
      return { status: res.status, ok, body: text, retryAfterMs }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from a component hostname (Tines tenant domain), a credential and app settings. */
export function buildTinesClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: TinesClient } | { error: string } {
  const token = resolveTinesToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }
  const host = hostname?.trim()
  if (!host) return { error: MISSING_COMPONENT_MESSAGE }
  const resolved = readTinesSettings(settings)
  return { client: new TinesClient({ hostname: host, token, timeoutMs: resolved.timeoutMs }) }
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
 * Extract a human-readable error from a Tines error response. Tines error
 * bodies are commonly shaped `{ error: "..." }` or `{ errors: [...] }`; fall
 * back to the raw body when neither shape matches.
 */
export function tinesErrorMessage(res: TinesResponse): string {
  const env = parseJson<{ error?: string; errors?: unknown; message?: string }>(res.body)
  if (env?.error) return env.error
  if (env?.message) return env.message
  if (env?.errors) return typeof env.errors === 'string' ? env.errors : JSON.stringify(env.errors)
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}
