// =============================================================================
// Rapid7 InsightVM Console API (v3) client.
//
// The v3 API lives ON the Security Console (on-prem), not the Insight cloud:
//   https://<console-host>:3780/api/3/
// Auth is HTTP Basic (a console username + password) — there is no API-key
// option on the console v3 API. Responses are HAL-style: collections carry
// { resources: [...], page: { number, size, totalResources, totalPages }, links }.
// Pagination is `?page=<0-based>&size=<=500`.
//
// The console ships a self-signed certificate by default; this client always
// uses HTTPS + Basic auth. If the console presents an untrusted cert, the
// platform host must trust it (install the CA) — this client does not disable
// TLS verification (handlers may not import a custom dispatcher).
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PORT = '3780'
const PAGE_SIZE = 500

export interface InsightVMSettings {
  /** Optional 2FA one-time token for a console account with 2FA enabled. */
  token: string | null
  timeoutMs: number
}

export function readInsightVMSettings(settings: Record<string, unknown>): InsightVMSettings {
  const rawToken = settings.two_factor_token
  const token = typeof rawToken === 'string' && rawToken.trim().length > 0 ? rawToken.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { token, timeoutMs }
}

export interface InsightVMCredentials {
  username: string
  password: string
}

/** Extract the console username + password from a Veltrix credential. */
export function resolveInsightVMCredentials(credential: CredentialRef | null): InsightVMCredentials | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  const password = (credential.password ?? credential.apiToken ?? '').trim()
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No InsightVM console credential — store a Security Console username in the credential "username" ' +
  'field and its password in the "password" field. Use a dedicated non-2FA service account with a ' +
  'role scoped to what this app manages.'

export interface InsightVMResponse {
  status: number
  ok: boolean
  body: string
}

export type InsightVMMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** HAL collection envelope. */
export interface HalCollection<T = unknown> {
  resources?: T[]
  page?: { number?: number; size?: number; totalResources?: number; totalPages?: number }
  links?: Array<{ rel?: string; href?: string }>
}

/** base64 without relying on Buffer typings leaking into the app tsconfig. */
function base64(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64')
}

export class InsightVMClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly token: string | null
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credentials: InsightVMCredentials; token: string | null; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.authHeader = `Basic ${base64(`${opts.credentials.username}:${opts.credentials.password}`)}`
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: InsightVMMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<InsightVMResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }
    if (this.token) headers.Token = this.token

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * GET every page of a HAL collection, concatenating `resources`. `path` is e.g.
   * `/sites`. Pages via `page` (0-based) + `size` until `page.totalPages`.
   */
  async getAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let page = 0
    let lastStatus = 0
    let lastBody = ''
    const maxPages = 200
    while (page < maxPages) {
      const res = await this.request('GET', path, { query: { ...query, page, size: PAGE_SIZE } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const hal = parseJson<HalCollection<T>>(res.body)
      const resources = hal?.resources
      if (Array.isArray(resources)) items.push(...resources)
      const totalPages = hal?.page?.totalPages ?? 1
      if (!Array.isArray(resources) || resources.length === 0 || page >= totalPages - 1) break
      page++
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }
}

/** Build a client from a component hostname (console host[:port]), a credential and settings. */
export function buildInsightVMClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: InsightVMClient; consoleUrl: string } | { error: string } {
  const creds = resolveInsightVMCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  let host = (hostname ?? '').trim()
  if (!host) {
    return {
      error:
        'No InsightVM console — register a component whose hostname is the Security Console host ' +
        '(e.g. console.example.com:3780). Port 3780 is assumed when omitted.',
    }
  }
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (!/:\d+$/.test(host)) host = `${host}:${DEFAULT_PORT}`

  const resolved = readInsightVMSettings(settings)
  const baseUrl = `https://${host}/api/3`

  return {
    client: new InsightVMClient({ baseUrl, credentials: creds, token: resolved.token, timeoutMs: resolved.timeoutMs }),
    consoleUrl: `https://${host}`,
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

/** Extract a human-readable error from an InsightVM v3 error response. */
export function insightVMErrorMessage(res: InsightVMResponse): string {
  const parsed = parseJson<{ message?: string; messages?: string[]; status?: number }>(res.body)
  if (parsed?.message) return parsed.message
  if (Array.isArray(parsed?.messages) && parsed!.messages.length > 0) return parsed!.messages.join('; ')
  return res.body || `HTTP ${res.status}`
}
