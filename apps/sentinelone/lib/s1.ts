// =============================================================================
// SentinelOne Management API client (v2.1).
//
// Auth is an API token sent as `Authorization: ApiToken <token>`. All calls hang
// off https://<console>.sentinelone.net/web/api/v2.1/ and return the envelope
// { data, pagination: { nextCursor, totalItems }, errors }. HTTP status is
// meaningful (>=400 = failure); `errors[]` carries the detail.
//
// SentinelOne scopes objects across an Account -> Site -> Group hierarchy (plus a
// global/tenant pseudo-scope). Collections (exclusions, restrictions, STAR rules,
// groups) carry the scope inside the request body's `filter` object (one of
// accountIds/siteIds/groupIds, or tenant:true) and as query params on GET; the
// per-scope policy singleton carries scope in the PATH (/sites/{id}/policy, ...).
// This client resolves a `scope` + `scopeId` setting into both forms.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`. Honors
// 429 with backoff (SentinelOne does not document a Retry-After header).
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type S1Scope = 'global' | 'account' | 'site' | 'group'
const SCOPES: S1Scope[] = ['global', 'account', 'site', 'group']

export interface S1Settings {
  scope: S1Scope
  scopeId: string | null
  apiVersion: string
  timeoutMs: number
}

export function readS1Settings(settings: Record<string, unknown>): S1Settings {
  const rawScope = typeof settings.scope === 'string' ? settings.scope.trim().toLowerCase() : ''
  const scope = (SCOPES.includes(rawScope as S1Scope) ? rawScope : 'account') as S1Scope

  const rawScopeId = settings.scope_id
  const scopeId =
    typeof rawScopeId === 'string' && rawScopeId.trim().length > 0 ? rawScopeId.trim() : null

  const rawVersion = settings.api_version
  const apiVersion = typeof rawVersion === 'string' && rawVersion.trim() ? rawVersion.trim() : '2.1'

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { scope, scopeId, apiVersion, timeoutMs }
}

/** Extract the SentinelOne API token from a Veltrix credential ("API token" or "password"). */
export function resolveS1Token(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No SentinelOne API token available — create a service-user API token in the SentinelOne console ' +
  '(Settings > Users) scoped at the level this app manages, and store it in the credential "API token" ' +
  'field.'

export const MISSING_SCOPE_MESSAGE =
  'No SentinelOne scope id — set the "Scope ID" app setting to the account/site/group id matching the ' +
  '"Scope" setting (only the "global" scope needs no id).'

export interface S1Response {
  status: number
  ok: boolean
  body: string
}

export type S1Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface S1Envelope<T = unknown> {
  data?: T
  pagination?: { nextCursor?: string | null; totalItems?: number }
  errors?: Array<{ code?: number; type?: string; title?: string; detail?: string }>
}

export class S1Client {
  private readonly baseUrl: string
  private readonly token: string
  private readonly scope: S1Scope
  private readonly scopeId: string | null
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; scope: S1Scope; scopeId: string | null; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.token = opts.token
    this.scope = opts.scope
    this.scopeId = opts.scopeId
    this.timeoutMs = opts.timeoutMs
  }

  get currentScope(): S1Scope {
    return this.scope
  }

  /** True when the configured scope has the id it needs (global needs none). */
  get hasScope(): boolean {
    return this.scope === 'global' || this.scopeId !== null
  }

  /**
   * The `filter` object that scopes a collection create/list body:
   * { tenant: true } for global, else { accountIds|siteIds|groupIds: [scopeId] }.
   * Non-union { filter, error } (never a discriminated union) so callers narrow
   * without help from the compiler / platform loader.
   */
  scopeFilter(): { filter: Record<string, unknown> | null; error: string | null } {
    if (this.scope === 'global') return { filter: { tenant: true }, error: null }
    if (!this.scopeId) return { filter: null, error: MISSING_SCOPE_MESSAGE }
    const key = this.scope === 'account' ? 'accountIds' : this.scope === 'site' ? 'siteIds' : 'groupIds'
    return { filter: { [key]: [this.scopeId] }, error: null }
  }

  /** Query params that scope a GET collection request. Non-union { query, error }. */
  scopeQuery(): { query: Record<string, string> | null; error: string | null } {
    if (this.scope === 'global') return { query: { tenant: 'true' }, error: null }
    if (!this.scopeId) return { query: null, error: MISSING_SCOPE_MESSAGE }
    const key = this.scope === 'account' ? 'accountIds' : this.scope === 'site' ? 'siteIds' : 'groupIds'
    return { query: { [key]: this.scopeId }, error: null }
  }

  /**
   * The path segment for the per-scope policy singleton (global is not valid for
   * policy). Non-union { path, error }.
   */
  policyPath(): { path: string | null; error: string | null } {
    if (this.scope === 'global') {
      return { path: null, error: 'The agent policy is per account/site/group — set the "Scope" setting to account, site or group.' }
    }
    if (!this.scopeId) return { path: null, error: MISSING_SCOPE_MESSAGE }
    const seg = this.scope === 'account' ? 'accounts' : this.scope === 'site' ? 'sites' : 'groups'
    return { path: `/${seg}/${this.scopeId}/policy`, error: null }
  }

  async request(
    method: S1Method,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<S1Response> {
    let res = await this.send(method, path, opts)
    let attempts = 0
    while (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS)
      res = await this.send(method, path, opts)
      attempts++
    }
    return res
  }

  /**
   * GET every page of a collection, following the cursor. `path` is e.g.
   * `/exclusions`; scope query params are added by the caller (or pass them in
   * `query`). Returns the concatenated `data` arrays.
   */
  async getAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let cursor: string | undefined
    let lastStatus = 0
    let lastBody = ''
    const maxPages = 100
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request('GET', path, { query: { limit: 1000, cursor, ...query } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<S1Envelope<T[]>>(res.body)
      const data = env?.data
      if (Array.isArray(data)) items.push(...data)
      const next = env?.pagination?.nextCursor
      if (!next) break
      cursor = next
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async send(
    method: S1Method,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<S1Response> {
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
          Authorization: `ApiToken ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from a component hostname (the console URL), a credential and settings. */
export function buildS1Client(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: S1Client; consoleUrl: string } | { error: string } {
  const token = resolveS1Token(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = (hostname ?? '').trim()
  if (!host) {
    return {
      error:
        'No SentinelOne console — register a component whose hostname is the management console URL ' +
        '(e.g. acme.sentinelone.net or usea1-partners.sentinelone.net).',
    }
  }

  const resolved = readS1Settings(settings)
  const cleaned = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const baseUrl = `https://${cleaned}/web/api/v${resolved.apiVersion}`

  return {
    client: new S1Client({
      baseUrl,
      token,
      scope: resolved.scope,
      scopeId: resolved.scopeId,
      timeoutMs: resolved.timeoutMs,
    }),
    consoleUrl: `https://${cleaned}`,
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

/** Extract the `data` payload from a SentinelOne envelope, or null. */
export function s1Result<T>(res: S1Response): T | null {
  const env = parseJson<S1Envelope<T>>(res.body)
  return (env?.data ?? null) as T | null
}

/** Extract a human-readable error from a SentinelOne envelope's `errors[]`. */
export function s1ErrorMessage(res: S1Response): string {
  const env = parseJson<S1Envelope>(res.body)
  const errors = env?.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors
      .map((e) => e.detail || e.title || e.type || (e.code ? `error ${e.code}` : 'error'))
      .join('; ')
  }
  return res.body || `HTTP ${res.status}`
}
