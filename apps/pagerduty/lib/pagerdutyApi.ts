// =============================================================================
// PagerDuty REST API v2 client.
//
// Auth is a PagerDuty REST API key sent VERBATIM in the Authorization header with
// the `Token token=` scheme (NOT a Bearer prefix): `Authorization: Token token=<key>`.
// Every request MUST carry `Accept: application/vnd.pagerduty+json;version=2` or the
// response behaviour is undefined. Writes send `Content-Type: application/json`.
//
// The base is FIXED at https://api.pagerduty.com for every account (PagerDuty has
// no per-tenant API subdomain), so — unlike a self-hosted tool — there is no host
// to resolve; only the API key is needed. Handlers run in-process, so this uses
// fetch with an AbortController timeout and never throws on an HTTP error status —
// callers inspect `status`/`ok` so they can tell a 404 from a real failure. Honors
// 429 Retry-After.
//
// Docs: https://developer.pagerduty.com/docs/rest-api-v2/authentication/
//       https://developer.pagerduty.com/api-reference/ (Escalation Policies)
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const BASE_URL = 'https://api.pagerduty.com'
export const PD_ACCEPT_HEADER = 'application/vnd.pagerduty+json;version=2'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000
const MAX_PAGES = 100
const PER_PAGE = 100

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const MISSING_CREDENTIAL_MESSAGE =
  'No PagerDuty REST API key available — create one in the PagerDuty web app ' +
  '(Integrations → API Access Keys) and store it in the credential\'s "API key" field. ' +
  'The app sends it as "Authorization: Token token=<key>" to https://api.pagerduty.com.'

export interface PagerDutySettings {
  timeoutMs: number
}

export function readPagerDutySettings(settings: Record<string, unknown>): PagerDutySettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

/** Extract the PagerDuty REST API key from a Veltrix credential ("API token" or "password"). */
export function resolvePagerDutyToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export interface PagerDutyResponse {
  status: number
  ok: boolean
  body: string
}

export type PagerDutyMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class PagerDutyClient {
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { token: string; timeoutMs: number }) {
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  /** A single request against https://api.pagerduty.com; path is e.g. `/escalation_policies`. */
  async request(
    method: PagerDutyMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<PagerDutyResponse> {
    let res = await this.send(method, path, opts)
    let attempts = 0
    while (res.status === 429 && attempts < 2) {
      if (res.retryAfterMs === null || res.retryAfterMs > MAX_RATE_LIMIT_WAIT_MS) break
      await sleep(res.retryAfterMs > 0 ? res.retryAfterMs : 1000)
      res = await this.send(method, path, opts)
      attempts++
    }
    return { status: res.status, ok: res.ok, body: res.body }
  }

  /**
   * GET every page of a classic-paginated collection, concatenating the array at
   * `wrapperKey` (e.g. "escalation_policies"). PagerDuty pages with limit/offset
   * and returns a `more` boolean plus `total`; loop until `more` is false.
   */
  async getAll<T = unknown>(
    path: string,
    wrapperKey: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let offset = 0
    let lastStatus = 0
    let lastBody = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request('GET', path, { query: { ...query, limit: PER_PAGE, offset } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<Record<string, unknown>>(res.body)
      const chunk = env && Array.isArray(env[wrapperKey]) ? (env[wrapperKey] as T[]) : []
      items.push(...chunk)
      const more = Boolean(env?.more)
      if (!more || chunk.length === 0) break
      offset += PER_PAGE
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  /**
   * GET every page of a CURSOR-paginated collection, concatenating the array at
   * `wrapperKey`. Unlike most of the REST API v2, the Automation Actions family
   * (/automation_actions/actions, /automation_actions/runners) pages with an
   * opaque `next_cursor` string instead of limit/offset + `more` — loop until the
   * response carries no `next_cursor` (or an empty one).
   */
  async getAllCursor<T = unknown>(
    path: string,
    wrapperKey: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let cursor: string | undefined
    let lastStatus = 0
    let lastBody = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.request('GET', path, { query: { ...query, limit: PER_PAGE, cursor } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<Record<string, unknown>>(res.body)
      const chunk = env && Array.isArray(env[wrapperKey]) ? (env[wrapperKey] as T[]) : []
      items.push(...chunk)
      const next = typeof env?.next_cursor === 'string' ? env.next_cursor : ''
      if (!next) break
      cursor = next
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async send(
    method: PagerDutyMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<PagerDutyResponse & { retryAfterMs: number | null }> {
    const url = new URL(`${BASE_URL}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Token token=${this.token}`,
          Accept: PD_ACCEPT_HEADER,
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

/** Build a client from a credential + app settings. The base URL is fixed. */
export function buildPagerDutyClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: PagerDutyClient } | { error: string } {
  const token = resolvePagerDutyToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }
  const resolved = readPagerDutySettings(settings)
  return { client: new PagerDutyClient({ token, timeoutMs: resolved.timeoutMs }) }
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
 * Extract a human-readable error from a PagerDuty error envelope. Errors are
 * shaped { error: { code, message, errors: [ ... ] } }; fall back to the raw body.
 */
export function pagerDutyErrorMessage(res: PagerDutyResponse): string {
  const env = parseJson<{ error?: { message?: string; code?: number; errors?: string[] } }>(res.body)
  const err = env?.error
  if (err) {
    const detail = Array.isArray(err.errors) && err.errors.length > 0 ? `: ${err.errors.join('; ')}` : ''
    return `${err.message ?? 'error'}${err.code ? ` (code ${err.code})` : ''}${detail}`
  }
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}
