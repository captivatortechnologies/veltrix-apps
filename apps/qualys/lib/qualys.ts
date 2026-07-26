// =============================================================================
// Qualys VMDR / Policy Compliance classic API (v2) client.
//
// Qualys is a multi-POD SaaS: every subscription lives on one "platform" whose
// API server is a fixed hostname (the component hostname), e.g.
//   US1  https://qualysapi.qualys.com
//   US2  https://qualysapi.qg2.apps.qualys.com
//   US3  https://qualysapi.qg3.apps.qualys.com
//   EU1  https://qualysapi.qg1.apps.qualys.eu
//   IN1  https://qualysapi.qg1.apps.qualys.in
// Find yours under Help > About in the Qualys UI.
//
// Auth is HTTP Basic (a Qualys account username + password). The classic v2 API
// additionally REQUIRES a non-empty `X-Requested-With` header on every call (a
// CSRF guard) — omitting it returns HTTP 400. Requests are form-encoded POSTs;
// responses are XML. Write operations (add/edit/create/update/delete) return a
// <SIMPLE_RETURN> document: success carries a <TEXT> message and an
// ITEM_LIST/ITEM (KEY=ID, VALUE=<new id>); failures carry a <CODE> + <TEXT>.
// Lists paginate via a trailing <WARNING> block whose <URL> points at the next
// page. Rate / concurrency limits surface as HTTP 409 with X-RateLimit-* /
// X-Concurrency-Limit-* headers.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`/`body`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
// Any non-empty value satisfies Qualys' CSRF guard; identify the caller.
const X_REQUESTED_WITH = 'Veltrix Qualys App'
// Each list page returns up to `truncation_limit` (default 1000) records; cap the
// number of pages we will follow so a huge account can't spin forever.
const MAX_PAGES = 50

export interface QualysSettings {
  timeoutMs: number
}

export function readQualysSettings(settings: Record<string, unknown>): QualysSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

export interface QualysCredentials {
  username: string
  password: string
}

/** Extract the Qualys account username + password from a Veltrix credential. */
export function resolveQualysCredentials(credential: CredentialRef | null): QualysCredentials | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  const password = (credential.password ?? credential.apiToken ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Qualys credential — store the Qualys account username in the credential "username" field and ' +
  'its password in the "password" field. Use a dedicated API service account with a role scoped to ' +
  'what this app manages (API access enabled).'

export interface QualysResponse {
  status: number
  ok: boolean
  body: string
}

/** A QPS (Qualys Platform Service, /qps/rest/…) JSON response. */
export interface QualysJsonResponse {
  status: number
  ok: boolean
  json: unknown
  body: string
}

/** Flat map of form parameters; values are coerced to strings when sent. */
export type QualysParams = Record<string, string | number | boolean | undefined | null>

/** base64 without relying on Buffer typings leaking into the app tsconfig. */
function base64(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
}

export class QualysClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: QualysCredentials; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.authHeader = `Basic ${base64(`${opts.credentials.username}:${opts.credentials.password}`)}`
    this.timeoutMs = opts.timeoutMs
  }

  /** POST a form-encoded request to `path` (e.g. `/api/2.0/fo/asset/group/`). */
  async post(path: string, params: QualysParams): Promise<QualysResponse> {
    return this.send('POST', `${this.baseUrl}${path}`, params)
  }

  /** Follow a fully-qualified Qualys URL (used for the pagination WARNING/URL). */
  async getUrl(url: string): Promise<QualysResponse> {
    return this.send('GET', url, undefined)
  }

  /** GET a classic-API path with query-string params (e.g. option_profile export). */
  async get(path: string, params: QualysParams): Promise<QualysResponse> {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      qs.set(key, String(value))
    }
    const query = qs.toString()
    return this.send('GET', `${this.baseUrl}${path}${query ? `?${query}` : ''}`, undefined)
  }

  /**
   * POST a JSON body to a QPS REST path (e.g. /qps/rest/2.0/create/am/tag). QPS
   * speaks JSON (ServiceRequest/ServiceResponse) rather than the classic form/XML
   * envelope; `body` is serialized as JSON and the parsed ServiceResponse is
   * returned on `json` (null when the payload is empty or not JSON). Pass
   * `undefined` for an empty-body POST (e.g. delete by id in the URL).
   */
  async postJson(path: string, body: unknown): Promise<QualysJsonResponse> {
    return this.sendJson('POST', `${this.baseUrl}${path}`, body)
  }

  private async send(method: 'GET' | 'POST', url: string, params: QualysParams | undefined): Promise<QualysResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      'X-Requested-With': X_REQUESTED_WITH,
      Accept: 'application/xml',
    }
    let body: string | undefined
    if (params) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      const form = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        form.set(key, String(value))
      }
      body = form.toString()
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  private async sendJson(method: 'GET' | 'POST', url: string, body: unknown): Promise<QualysJsonResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      // QPS ignores it, but every request from this app identifies itself.
      'X-Requested-With': X_REQUESTED_WITH,
      Accept: 'application/json',
    }
    let payload: string | undefined
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { method, headers, body: payload, signal: controller.signal })
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

  /**
   * List every record of a classic-API collection, following the trailing
   * <WARNING>/<URL> pagination pointer. `blockTag` is the repeating element name
   * (e.g. `ASSET_GROUP`); returns each block's inner XML for the caller to map.
   */
  async list(
    path: string,
    params: QualysParams,
    blockTag: string,
  ): Promise<{ ok: boolean; blocks: string[]; status: number; body: string }> {
    const first = await this.post(path, { ...params, action: 'list' })
    if (!first.ok) return { ok: false, blocks: [], status: first.status, body: first.body }

    const blocks: string[] = []
    let body = first.body
    let pages = 0
    while (pages < MAX_PAGES) {
      for (const block of xmlBlocks(body, blockTag)) blocks.push(block)
      const next = nextPageUrl(body)
      if (!next) break
      const res = await this.getUrl(next)
      if (!res.ok) return { ok: false, blocks, status: res.status, body: res.body }
      body = res.body
      pages++
    }
    return { ok: true, blocks, status: first.status, body }
  }
}

/** Build a client from the component hostname (Qualys platform URL), a credential and settings. */
export function buildQualysClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: QualysClient; platformUrl: string } | { error: string } {
  const creds = resolveQualysCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  let host = (hostname ?? '').trim()
  if (!host) {
    return {
      error:
        'No Qualys platform URL — register a component whose hostname is your Qualys API server ' +
        '(e.g. qualysapi.qg2.apps.qualys.com). Find it under Help > About in the Qualys UI.',
    }
  }
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()

  const resolved = readQualysSettings(settings)
  const platformUrl = `https://${host}`
  return {
    client: new QualysClient({ baseUrl: platformUrl, credentials: creds, timeoutMs: resolved.timeoutMs }),
    platformUrl,
  }
}

// --- XML helpers --------------------------------------------------------------
// The classic API returns small, flat XML documents; these regex helpers are
// sufficient for the SIMPLE_RETURN envelope and the list element blocks this app
// reads. They never throw — malformed input yields '' / [] / null.

/** Decode the XML entities Qualys emits (named + numeric). `&amp;` decoded last. */
export function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

function tagRegex(tag: string, flags: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, flags)
}

function unwrap(inner: string): string {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  if (cdata) return cdata[1]
  return decodeXmlEntities(inner).trim()
}

/** First `<tag>…</tag>` inner text (CDATA-unwrapped, entity-decoded), or ''. */
export function xmlText(xml: string, tag: string): string {
  const match = xml.match(tagRegex(tag, ''))
  return match ? unwrap(match[1]) : ''
}

/** Inner XML of every top-level `<tag>…</tag>` block (elements that do not self-nest). */
export function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = []
  for (const match of xml.matchAll(tagRegex(tag, 'g'))) out.push(match[1])
  return out
}

/** Every `<tag>…</tag>` inner text within a block (e.g. the QIDs in a search list). */
export function xmlTextList(xml: string, tag: string): string[] {
  const out: string[] = []
  for (const match of xml.matchAll(tagRegex(tag, 'g'))) out.push(unwrap(match[1]))
  return out
}

/** The next-page URL from a list response's trailing <WARNING> block, or null. */
export function nextPageUrl(xml: string): string | null {
  const warning = xml.match(/<WARNING>([\s\S]*?)<\/WARNING>/i)
  if (!warning) return null
  const url = xmlText(warning[1], 'URL')
  return url || null
}

/** The new object id from a SIMPLE_RETURN (ITEM where KEY=ID → VALUE), or null. */
export function qualysReturnId(xml: string): string | null {
  const match = xml.match(/<ITEM>\s*<KEY>\s*ID\s*<\/KEY>\s*<VALUE>([\s\S]*?)<\/VALUE>\s*<\/ITEM>/i)
  return match ? unwrap(match[1]) : null
}

/**
 * Inspect a write response and return an error message when Qualys rejected it,
 * or null on success. NON-UNION `string | null` — no discriminated-union
 * narrowing (the platform handler loader can't narrow those). A SIMPLE_RETURN
 * error carries a top-level <CODE>; a success does not.
 */
export function qualysWriteError(res: QualysResponse): string | null {
  if (!res.ok) return qualysErrorMessage(res)
  if (xmlText(res.body, 'CODE')) return qualysErrorMessage(res)
  return null
}

/** Extract a human-readable message from a Qualys XML response. */
export function qualysErrorMessage(res: QualysResponse): string {
  const text = xmlText(res.body, 'TEXT')
  const code = xmlText(res.body, 'CODE')
  if (text) return code ? `${text} (Qualys code ${code})` : text
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

// --- QPS (ServiceResponse) helpers --------------------------------------------
// The Asset Management & Tagging API (/qps/rest/2.0/) wraps every payload in a
// ServiceResponse whose `responseCode` is "SUCCESS" on success; failures carry a
// responseErrorDetails.errorMessage. `data` is a list of typed wrappers, e.g.
// [{ "Tag": { "id": 1, "name": "…" } }]. These helpers never throw.

function serviceResponse(res: QualysJsonResponse): Record<string, unknown> | null {
  const sr = (res.json as { ServiceResponse?: unknown } | null)?.ServiceResponse
  return sr && typeof sr === 'object' ? (sr as Record<string, unknown>) : null
}

/** The ServiceResponse.responseCode, or '' when absent. */
export function qpsResponseCode(res: QualysJsonResponse): string {
  const code = serviceResponse(res)?.responseCode
  return typeof code === 'string' ? code : ''
}

/** Human-readable message from a QPS ServiceResponse (error detail preferred). */
export function qpsErrorMessage(res: QualysJsonResponse): string {
  const sr = serviceResponse(res)
  const details = sr?.responseErrorDetails as { errorMessage?: unknown } | undefined
  const message = typeof details?.errorMessage === 'string' ? details.errorMessage : ''
  const code = typeof sr?.responseCode === 'string' ? sr.responseCode : ''
  if (message) return code ? `${message} (${code})` : message
  if (code) return `Qualys responseCode ${code}`
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

/**
 * Inspect a QPS write response and return an error message when Qualys rejected
 * it, or null on success. NON-UNION `string | null` (the platform handler loader
 * cannot narrow discriminated unions). Success is HTTP 2xx AND responseCode
 * SUCCESS.
 */
export function qpsWriteError(res: QualysJsonResponse): string | null {
  if (!res.ok) return qpsErrorMessage(res)
  const code = qpsResponseCode(res)
  if (code && code !== 'SUCCESS') return qpsErrorMessage(res)
  return null
}

/** Every entity of `typeKey` (e.g. 'Tag') from a ServiceResponse.data list. */
export function qpsDataList(res: QualysJsonResponse, typeKey: string): Record<string, unknown>[] {
  const data = serviceResponse(res)?.data
  if (!Array.isArray(data)) return []
  const out: Record<string, unknown>[] = []
  for (const entry of data) {
    const value = (entry as Record<string, unknown> | null)?.[typeKey]
    if (value && typeof value === 'object') out.push(value as Record<string, unknown>)
  }
  return out
}

/** True when ServiceResponse.hasMoreRecords indicates another page. */
export function qpsHasMoreRecords(res: QualysJsonResponse): boolean {
  const more = serviceResponse(res)?.hasMoreRecords
  return more === true || more === 'true'
}
