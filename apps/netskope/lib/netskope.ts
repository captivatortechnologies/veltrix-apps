// =============================================================================
// Netskope REST API v2 client.
//
// Auth is a single header on every request:
//   Netskope-Api-Token: <token>
// The base is the tenant host: https://<tenant>.goskope.com/api/v2. Lists page
// with limit/offset. Rate limiting is HTTP 429 (no reliable Retry-After) — this
// retries once with a short backoff.
//
// Convention for the Veltrix credential:
//   password / apiToken -> the REST API v2 token
//   tenant              -> the `tenant` app setting (acme.goskope.com)
//
// URL lists follow a pending → deploy model: create/update/delete only STAGE a
// change; POST /policy/urllist/deploy applies all pending url-list changes on the
// tenant. Callers batch their writes, then issue a single deploy.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const RATE_LIMIT_BACKOFF_MS = 1_000
export const DEFAULT_PAGE_LIMIT = 100

export interface NetskopeSettings {
  timeoutMs: number
  /** Fully-resolved base, e.g. https://acme.goskope.com/api/v2 (no trailing slash). */
  baseUrl: string | null
}

export function readNetskopeSettings(settings: Record<string, unknown>): NetskopeSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawTenant = settings.tenant
  let baseUrl: string | null = null
  if (typeof rawTenant === 'string' && rawTenant.trim()) {
    let host = rawTenant.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    host = host.replace(/\/api\/v2$/, '')
    if (host) baseUrl = `https://${host}/api/v2`
  }
  return { timeoutMs, baseUrl }
}

export interface NetskopeCredential {
  baseUrl: string
  token: string
}

export function resolveNetskopeCredential(
  credential: CredentialRef | null,
  settings: NetskopeSettings
): NetskopeCredential | null {
  if (!credential) return null
  const token = (credential.password ?? (credential as { apiToken?: string }).apiToken ?? '').trim()
  const baseUrl = (settings.baseUrl ?? '').trim()
  if (!token || !baseUrl) return null
  return { baseUrl, token }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Netskope credential — this app authenticates to the Netskope REST API v2 with a tenant ' +
  'API token. Store the token in the credential "password" field and set the tenant host ' +
  '(acme.goskope.com) in the app\'s "Tenant" setting. The token must be granted the ' +
  '/api/v2/policy/urllist and /api/v2/policy/urllist/deploy endpoints with Read + Write privilege.'

export interface NetskopeResponse {
  status: number
  ok: boolean
  body: string
  transportError?: string
}

export type NetskopeMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class NetskopeClient {
  private readonly cred: NetskopeCredential
  private readonly timeoutMs: number

  constructor(opts: { cred: NetskopeCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  async request(method: NetskopeMethod, path: string, body?: unknown): Promise<NetskopeResponse> {
    const url = path.startsWith('http') ? path : `${this.cred.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'Netskope-Api-Token': this.cred.token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await res.text()
        if (res.status === 429 && attempt === 0) {
          const retryAfter = Number(res.headers.get('Retry-After'))
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : RATE_LIMIT_BACKOFF_MS)
          continue
        }
        return { status: res.status, ok: res.ok, body: text }
      } catch (err) {
        if (attempt === 0) continue
        return { status: 0, ok: false, body: '', transportError: err instanceof Error ? err.message : 'request error' }
      } finally {
        clearTimeout(timer)
      }
    }
    return { status: 0, ok: false, body: '', transportError: 'request failed' }
  }

  get(path: string): Promise<NetskopeResponse> {
    return this.request('GET', path)
  }
  post(path: string, body?: unknown): Promise<NetskopeResponse> {
    return this.request('POST', path, body)
  }
  put(path: string, body: unknown): Promise<NetskopeResponse> {
    return this.request('PUT', path, body)
  }
  patch(path: string, body: unknown): Promise<NetskopeResponse> {
    return this.request('PATCH', path, body)
  }
  delete(path: string): Promise<NetskopeResponse> {
    return this.request('DELETE', path)
  }

  /** GET a collection, paging with limit/offset until a short page. Netskope
   *  policy endpoints return a bare array. */
  async getAll<T = unknown>(path: string, pageLimit = DEFAULT_PAGE_LIMIT, maxPages = 100): Promise<{ ok: boolean; items: T[]; lastError?: NetskopeResponse }> {
    const items: T[] = []
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageLimit
      const sep = path.includes('?') ? '&' : '?'
      const res = await this.get(`${path}${sep}limit=${pageLimit}&offset=${offset}`)
      if (!res.ok) return { ok: false, items, lastError: res }
      const arr = extractArray<T>(res.body)
      if (arr.length === 0) break
      items.push(...arr)
      if (arr.length < pageLimit) break
    }
    return { ok: true, items }
  }

  /** GET an NPA (infrastructure/steering) collection, paging with limit/offset.
   *  These endpoints wrap the list under data.<listKey> (e.g. data.publishers)
   *  instead of returning a bare array. */
  async getAllNpa<T = unknown>(path: string, listKey: string, pageLimit = DEFAULT_PAGE_LIMIT, maxPages = 100): Promise<{ ok: boolean; items: T[]; lastError?: NetskopeResponse }> {
    const items: T[] = []
    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageLimit
      const sep = path.includes('?') ? '&' : '?'
      const res = await this.get(`${path}${sep}limit=${pageLimit}&offset=${offset}`)
      if (!res.ok) return { ok: false, items, lastError: res }
      const arr = extractNpaList<T>(res.body, listKey)
      if (arr.length === 0) break
      items.push(...arr)
      if (arr.length < pageLimit) break
    }
    return { ok: true, items }
  }
}

export function buildNetskopeClient(cred: NetskopeCredential, settings: NetskopeSettings): NetskopeClient {
  return new NetskopeClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Netskope list endpoints usually return a bare array, but tolerate a
 *  {data:[...]} / {result:[...]} wrapper. */
export function extractArray<T>(body: string): T[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as { data?: unknown; result?: unknown }
    if (Array.isArray(obj.data)) return obj.data as T[]
    if (Array.isArray(obj.result)) return obj.result as T[]
  }
  return []
}

/** NPA infrastructure/steering endpoints wrap payloads in a {status, data, ...}
 *  envelope. Lists live under data.<listKey> (e.g. data.publishers,
 *  data.private_apps); some responses put a bare array in data. This unwraps
 *  either shape. */
export function extractNpaList<T>(body: string, listKey: string): T[] {
  const parsed = parseJson<{ data?: unknown }>(body)
  const data = parsed?.data
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object') {
    const arr = (data as Record<string, unknown>)[listKey]
    if (Array.isArray(arr)) return arr as T[]
  }
  return []
}

/** Unwrap a single NPA object from a {data:{...}} envelope (create/get). Falls
 *  back to the raw parsed object when the response is not enveloped. */
export function extractNpaObject<T>(body: string): T | null {
  const parsed = parseJson<{ data?: unknown }>(body)
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    const data = (parsed as { data?: unknown }).data
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as T
  }
  return (parsed as T) ?? null
}

export function netskopeErrorMessage(res: NetskopeResponse): string {
  if (res.transportError) return res.transportError
  const parsed = parseJson<{ message?: string; error?: string; errors?: Array<{ message?: string }> }>(res.body)
  const msg = parsed?.message || parsed?.error || parsed?.errors?.map((e) => e.message).filter(Boolean).join('; ')
  return msg || res.body?.slice(0, 300) || `Netskope request failed (status ${res.status})`
}
