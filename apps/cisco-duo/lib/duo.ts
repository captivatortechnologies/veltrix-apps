// =============================================================================
// Cisco Duo Admin API client.
//
// The Duo Admin API uses HTTP Basic auth where the password is a per-request
// HMAC-SHA1 signature over a canonical string:
//   date \n METHOD \n host \n path \n sorted-url-encoded-params
// signed with the secret key; the integration key is the Basic username and the
// hex signature is the Basic password. Params are form-encoded (query string for
// GET/DELETE, request body for POST) and MUST be byte-identical to what was
// signed.
//
// Convention for the Veltrix credential:
//   username -> integration key (ikey)
//   password -> secret key (skey)  — used as the HMAC key, never sent directly
//   api host -> the `api_host` app setting (api-XXXXXXXX.duosecurity.com)
//
// Responses use the envelope { stat: "OK", response } / { stat: "FAIL", code,
// message, message_detail }. Paged lists carry metadata.next_offset.
// =============================================================================

import { createHmac } from 'node:crypto'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** Duo list pages cap at 300. */
export const MAX_PAGE_LIMIT = 300

export interface DuoSettings {
  timeoutMs: number
  /** api-XXXXXXXX.duosecurity.com (lowercase, no scheme). */
  host: string | null
}

export function readDuoSettings(settings: Record<string, unknown>): DuoSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawHost = settings.api_host
  let host: string | null = null
  if (typeof rawHost === 'string' && rawHost.trim()) {
    host = rawHost.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase()
  }
  return { timeoutMs, host }
}

export interface DuoCredential {
  host: string
  ikey: string
  skey: string
}

export function resolveDuoCredential(
  credential: CredentialRef | null,
  settings: DuoSettings
): DuoCredential | null {
  if (!credential) return null
  const ikey = (credential.username ?? '').trim()
  const skey = (credential.password ?? '').trim()
  const host = (settings.host ?? '').trim()
  if (!ikey || !skey || !host) return null
  return { host, ikey, skey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Cisco Duo credential — this app authenticates to the Duo Admin API with an integration ' +
  'key + secret key. Store the integration key in the credential "username" field and the secret key ' +
  'in "password", and set the API hostname (api-XXXXXXXX.duosecurity.com) in the app\'s "API Host" ' +
  'setting. The Admin API integration needs the "Grant applications"/"Grant read/write resources" ' +
  'permissions for what this app manages.'

export interface DuoResponse {
  ok: boolean
  httpStatus: number
  /** the `response` field of the envelope, or null. */
  response: unknown
  /** Duo error code on FAIL. */
  code?: number
  message?: string
  nextOffset?: number | null
  transportError?: string
}

export type DuoMethod = 'GET' | 'POST' | 'DELETE'

/** RFC 3986 percent-encoding (encodeURIComponent + !*'() ), uppercase hex. */
export function duoEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** Canonical, sorted, url-encoded `key=value&...` param string. */
export function canonicalParams(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${duoEncode(k)}=${duoEncode(params[k])}`)
    .join('&')
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** RFC 2822 date in UTC with a numeric -0000 offset, as Duo expects. */
export function rfc2822(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0')
  return (
    `${DAYS[date.getUTCDay()]}, ${p2(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:${p2(date.getUTCSeconds())} -0000`
  )
}

export class DuoClient {
  private readonly cred: DuoCredential
  private readonly timeoutMs: number

  constructor(opts: { cred: DuoCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  private sign(method: DuoMethod, path: string, date: string, paramString: string): string {
    const canonical = [date, method, this.cred.host, path, paramString].join('\n')
    const sig = createHmac('sha1', this.cred.skey).update(canonical).digest('hex')
    return 'Basic ' + Buffer.from(`${this.cred.ikey}:${sig}`).toString('base64')
  }

  async request(method: DuoMethod, path: string, params: Record<string, string> = {}): Promise<DuoResponse> {
    const date = rfc2822(new Date())
    const paramString = canonicalParams(params)
    const auth = this.sign(method, path, date, paramString)

    let url = `https://${this.cred.host}${path}`
    let body: string | undefined
    const headers: Record<string, string> = { Authorization: auth, Date: date, Accept: 'application/json' }
    if (method === 'POST') {
      body = paramString
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (paramString) {
      url += `?${paramString}`
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal })
      const text = await res.text()
      const parsed = parseJson<{
        stat?: string
        response?: unknown
        code?: number
        message?: string
        message_detail?: string
        metadata?: { next_offset?: number | null }
      }>(text)
      if (parsed?.stat === 'OK') {
        return { ok: true, httpStatus: res.status, response: parsed.response ?? null, nextOffset: parsed.metadata?.next_offset ?? null }
      }
      return {
        ok: false,
        httpStatus: res.status,
        response: null,
        code: parsed?.code,
        message: parsed?.message_detail ? `${parsed.message}: ${parsed.message_detail}` : parsed?.message ?? `HTTP ${res.status}`,
      }
    } catch (err) {
      return { ok: false, httpStatus: 0, response: null, transportError: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  get(path: string, params?: Record<string, string>): Promise<DuoResponse> {
    return this.request('GET', path, params)
  }
  post(path: string, params?: Record<string, string>): Promise<DuoResponse> {
    return this.request('POST', path, params)
  }
  delete(path: string): Promise<DuoResponse> {
    return this.request('DELETE', path)
  }

  /** GET a paged collection following metadata.next_offset. */
  async getAll<T = unknown>(path: string, maxPages = 40): Promise<{ ok: boolean; items: T[]; lastError?: DuoResponse }> {
    const items: T[] = []
    let offset = 0
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get(path, { limit: String(MAX_PAGE_LIMIT), offset: String(offset) })
      if (!res.ok) return { ok: false, items, lastError: res }
      if (Array.isArray(res.response)) items.push(...(res.response as T[]))
      if (res.nextOffset === null || res.nextOffset === undefined) break
      offset = res.nextOffset
    }
    return { ok: true, items }
  }
}

export function buildDuoClient(cred: DuoCredential, settings: DuoSettings): DuoClient {
  return new DuoClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function duoErrorMessage(res: DuoResponse): string {
  if (res.transportError) return res.transportError
  return res.code ? `${res.message} (code ${res.code})` : res.message ?? `Duo request failed (HTTP ${res.httpStatus})`
}
