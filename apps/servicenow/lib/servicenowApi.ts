// =============================================================================
// ServiceNow Table API client (HTTP Basic auth).
//
// One path: HTTPS REST against a ServiceNow instance's Table API, rooted at
//   https://<instance>.service-now.com/api/now/
// ServiceNow SaaS instances present a valid, publicly-trusted TLS certificate,
// so this uses the platform's global `fetch` with an AbortController timeout
// (same posture as the qualys client) rather than a self-signed-tolerant
// transport.
//
// Auth is HTTP Basic — a ServiceNow account username + password sent as
//   Authorization: Basic base64(username:password)
// Use a dedicated integration user whose roles are scoped to exactly what this
// app manages (see README). OAuth 2.0 (POST /oauth_token.do → Bearer token) is
// ServiceNow's recommended production method and is a planned follow-up; v0.1.0
// ships Basic auth only.
//
// The Table API wraps every JSON payload in a top-level `result` key:
//   list   GET  /api/now/table/{table}           -> { result: [ {...}, ... ] }
//   read   GET  /api/now/table/{table}/{sys_id}  -> { result: {...} }
//   create POST /api/now/table/{table}           -> 201 { result: {...} }  (new sys_id)
//   update PATCH/api/now/table/{table}/{sys_id}  -> 200 { result: {...} }  (partial)
//   delete DELETE/api/now/table/{table}/{sys_id} -> 204 (no body)
// PATCH is used for updates (partial) — PUT replaces the whole record and would
// blank any field we do not send.
//
// Handlers run in-process, so no method throws on an HTTP error status — callers
// inspect `status` / `ok` / `json` / `body`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_TIMEOUT_MS = 30_000

export interface ServiceNowCredentials {
  username: string
  password: string
}

/** Extract the ServiceNow account username + password from a Veltrix credential. */
export function resolveServiceNowCredentials(credential: CredentialRef | null): ServiceNowCredentials | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  const password = (credential.password ?? credential.apiToken ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No ServiceNow credential — store the integration user name in the credential "username" field ' +
  'and its password in the "password" field. Use a dedicated integration user whose roles are ' +
  'scoped to what this app manages (e.g. admin/security_admin for business rules).'

/** Normalize a raw instance host or URL into an https base with no trailing slash. */
export function normalizeInstanceUrl(raw: string | undefined | null): string | null {
  let host = (raw ?? '').trim()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
  if (!host) return null
  return `https://${host}`
}

/** ServiceNow settings the handlers honor (currently just the request timeout). */
export interface ServiceNowSettings {
  timeoutMs: number
}

export function readServiceNowSettings(settings: Record<string, unknown>): ServiceNowSettings {
  const raw = settings?.request_timeout_seconds
  const timeoutMs =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : DEFAULT_TIMEOUT_MS
  return { timeoutMs }
}

export interface ServiceNowResponse {
  status: number
  ok: boolean
  /** Parsed JSON body (null when empty or not JSON). */
  json: unknown
  /** Raw response text (for error messages / non-JSON bodies). */
  body: string
}

/** Query parameters for a Table API list request. */
export interface TableQuery {
  /** Encoded query (sysparm_query), e.g. `name=My Rule^collection=incident`. */
  query?: string
  /** sysparm_limit — max records returned. */
  limit?: number
  /** sysparm_fields — comma-separated field allow-list to return. */
  fields?: string[]
  /** sysparm_display_value — false (raw values, the default), true, or 'all'. */
  displayValue?: 'true' | 'false' | 'all'
}

/** base64 without leaking Buffer typings into the app tsconfig. */
function base64(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
}

export class ServiceNowClient {
  private readonly apiBase: string
  private readonly authHeader: string
  private readonly timeoutMs: number

  constructor(opts: { instanceUrl: string; credentials: ServiceNowCredentials; timeoutMs: number }) {
    this.apiBase = `${opts.instanceUrl.replace(/\/+$/, '')}/api/now`
    this.authHeader = `Basic ${base64(`${opts.credentials.username}:${opts.credentials.password}`)}`
    this.timeoutMs = opts.timeoutMs
  }

  /** GET a page of records from a table. Returns the `result` array (or [] on error). */
  async list(table: string, query: TableQuery = {}): Promise<ServiceNowResponse> {
    const qs = new URLSearchParams()
    if (query.query) qs.set('sysparm_query', query.query)
    if (query.limit !== undefined) qs.set('sysparm_limit', String(query.limit))
    if (query.fields && query.fields.length) qs.set('sysparm_fields', query.fields.join(','))
    qs.set('sysparm_display_value', query.displayValue ?? 'false')
    // Reference fields as plain sys_ids (no embedded link objects) keep bodies flat.
    qs.set('sysparm_exclude_reference_link', 'true')
    const path = `/table/${encodeURIComponent(table)}?${qs.toString()}`
    return this.send('GET', path)
  }

  /** GET a single record by sys_id. */
  async get(table: string, sysId: string, fields?: string[]): Promise<ServiceNowResponse> {
    const qs = new URLSearchParams()
    if (fields && fields.length) qs.set('sysparm_fields', fields.join(','))
    qs.set('sysparm_display_value', 'false')
    qs.set('sysparm_exclude_reference_link', 'true')
    const path = `/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}?${qs.toString()}`
    return this.send('GET', path)
  }

  /** POST a new record. ServiceNow returns 201 with the created record (incl. sys_id). */
  async create(table: string, body: Record<string, unknown>): Promise<ServiceNowResponse> {
    return this.send('POST', `/table/${encodeURIComponent(table)}`, body)
  }

  /** PATCH an existing record by sys_id (partial update — only the sent fields change). */
  async update(table: string, sysId: string, body: Record<string, unknown>): Promise<ServiceNowResponse> {
    return this.send('PATCH', `/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`, body)
  }

  /** DELETE a record by sys_id. ServiceNow returns 204 (no body) on success. */
  async remove(table: string, sysId: string): Promise<ServiceNowResponse> {
    return this.send('DELETE', `/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`)
  }

  private async send(method: string, path: string, body?: unknown): Promise<ServiceNowResponse> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
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
      const res = await fetch(`${this.apiBase}${path}`, { method, headers, body: payload, signal: controller.signal })
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
}

/** Build a client from the instance host/URL, a credential and settings. */
export function buildServiceNowClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: ServiceNowClient; instanceUrl: string } | { error: string } {
  const creds = resolveServiceNowCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const instanceUrl = normalizeInstanceUrl(hostname)
  if (!instanceUrl) {
    return {
      error:
        'No ServiceNow instance — register a component whose hostname is your instance address ' +
        '(e.g. dev12345.service-now.com).',
    }
  }

  const resolved = readServiceNowSettings(settings)
  return {
    client: new ServiceNowClient({ instanceUrl, credentials: creds, timeoutMs: resolved.timeoutMs }),
    instanceUrl,
  }
}

/** Pull the `result` array out of a list response (or [] when absent). */
export function resultList(res: ServiceNowResponse): Record<string, unknown>[] {
  const result = (res.json as { result?: unknown } | null)?.result
  if (!Array.isArray(result)) return []
  return result.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
}

/** Pull the single `result` object out of a read/create/update response (or null). */
export function resultObject(res: ServiceNowResponse): Record<string, unknown> | null {
  const result = (res.json as { result?: unknown } | null)?.result
  return result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null
}

/** Human-readable message from a ServiceNow error response (`error.message` preferred). */
export function serviceNowErrorMessage(res: ServiceNowResponse): string {
  const error = (res.json as { error?: { message?: unknown; detail?: unknown } } | null)?.error
  const message = typeof error?.message === 'string' ? error.message : ''
  const detail = typeof error?.detail === 'string' ? error.detail : ''
  if (message) return detail ? `${message} — ${detail}` : message
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}
