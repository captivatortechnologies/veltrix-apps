// =============================================================================
// Palo Alto Prisma Cloud (CSPM) REST API client.
//
// Auth is an access-key login that returns a short-lived JWT:
//   POST /login { username: <access key id>, password: <secret key> } -> { token }
// The JWT is sent on every subsequent call as the `x-redlock-auth` header and is
// valid ~10 minutes; the client re-logs in on 401.
//
// Convention for the Veltrix credential:
//   username -> access key id
//   password -> secret key
//   api url  -> the `api_url` app setting (per-tenant, e.g. https://api.prismacloud.io)
//
// Errors surface machine-readable reasons in the `x-redlock-status` header
// (a JSON array of { i18nKey, severity }); the client exposes it for callers.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

export interface PcSettings {
  timeoutMs: number
  /** Per-tenant API base, e.g. https://api.prismacloud.io (no trailing slash). */
  baseUrl: string | null
}

export function readPcSettings(settings: Record<string, unknown>): PcSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawUrl = settings.api_url
  let baseUrl: string | null = null
  if (typeof rawUrl === 'string' && rawUrl.trim()) {
    const u = rawUrl.trim().replace(/\/+$/, '')
    baseUrl = /^https?:\/\//.test(u) ? u : `https://${u}`
  }
  return { timeoutMs, baseUrl }
}

export interface PcCredential {
  baseUrl: string
  accessKeyId: string
  secretKey: string
}

export function resolvePcCredential(credential: CredentialRef | null, settings: PcSettings): PcCredential | null {
  if (!credential) return null
  const accessKeyId = (credential.username ?? '').trim()
  const secretKey = (credential.password ?? '').trim()
  const baseUrl = (settings.baseUrl ?? '').trim()
  if (!accessKeyId || !secretKey || !baseUrl) return null
  return { baseUrl, accessKeyId, secretKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Prisma Cloud credential — this app authenticates to the Prisma Cloud CSPM API with an ' +
  'access key. Store the Access Key ID in the credential "username" field and the Secret Key in ' +
  '"password", and set the tenant API URL (e.g. https://api.prismacloud.io) in the app\'s "API URL" ' +
  'setting.'

export interface PcResponse {
  status: number
  ok: boolean
  body: string
  /** parsed x-redlock-status i18nKeys, when present. */
  statusKeys: string[]
  transportError?: string
}

export type PcMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export class PcClient {
  private readonly cred: PcCredential
  private readonly timeoutMs: number
  private token: string | null = null

  constructor(opts: { cred: PcCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  private async login(): Promise<{ error?: string }> {
    const res = await this.raw('POST', '/login', { username: this.cred.accessKeyId, password: this.cred.secretKey }, false)
    if (!res.ok) return { error: res.transportError ?? `login failed (HTTP ${res.status})` }
    const parsed = parseJson<{ token?: string }>(res.body)
    if (!parsed?.token) return { error: 'login response missing token' }
    this.token = parsed.token
    return {}
  }

  private async raw(method: PcMethod, path: string, body: unknown, auth: boolean): Promise<PcResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
      if (auth && this.token) headers['x-redlock-auth'] = this.token
      const res = await fetch(`${this.cred.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      const statusHeader = res.headers.get('x-redlock-status')
      const statusKeys = statusHeader ? (parseJson<Array<{ i18nKey?: string }>>(statusHeader) ?? []).map((s) => s.i18nKey ?? '').filter(Boolean) : []
      return { status: res.status, ok: res.ok, body: text, statusKeys }
    } catch (err) {
      return { status: 0, ok: false, body: '', statusKeys: [], transportError: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Authenticated request; logs in on demand and retries once on 401. */
  async request(method: PcMethod, path: string, body?: unknown): Promise<PcResponse> {
    if (!this.token) {
      const auth = await this.login()
      if (auth.error) return { status: 0, ok: false, body: '', statusKeys: [], transportError: auth.error }
    }
    let res = await this.raw(method, path, body, true)
    if (res.status === 401) {
      this.token = null
      const auth = await this.login()
      if (!auth.error) res = await this.raw(method, path, body, true)
    }
    return res
  }

  get(path: string): Promise<PcResponse> {
    return this.request('GET', path)
  }
  post(path: string, body?: unknown): Promise<PcResponse> {
    return this.request('POST', path, body)
  }
  put(path: string, body: unknown): Promise<PcResponse> {
    return this.request('PUT', path, body)
  }
  /** Some endpoints (e.g. the user enable/disable toggle) take the value as a path segment, not a body. */
  patch(path: string, body?: unknown): Promise<PcResponse> {
    return this.request('PATCH', path, body)
  }
  delete(path: string): Promise<PcResponse> {
    return this.request('DELETE', path)
  }
}

export function buildPcClient(cred: PcCredential, settings: PcSettings): PcClient {
  return new PcClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function pcErrorMessage(res: PcResponse): string {
  if (res.transportError) return res.transportError
  if (res.statusKeys.length) return res.statusKeys.join(', ')
  const parsed = parseJson<{ message?: string; code?: string }>(res.body)
  return parsed?.message || parsed?.code || res.body?.slice(0, 300) || `Prisma Cloud request failed (HTTP ${res.status})`
}
