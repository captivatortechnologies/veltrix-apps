// =============================================================================
// IBM QRadar REST API client.
//
// Auth is an authorized-service token sent in the `SEC` header, plus a required
// `Version` header pinning the API version. The base is https://<console>/api.
// Reference sets are the classic name-keyed reference-data API:
//   POST   /reference_data/sets?name=X&element_type=IP   (create; query params)
//   GET    /reference_data/sets/{name}                    (read set + values)
//   POST   /reference_data/sets/{name}?value=V            (add one value)
//   DELETE /reference_data/sets/{name}/{value}            (remove one value)
//   DELETE /reference_data/sets/{name}                    (delete set; async 202)
//
// Convention for the Veltrix credential:
//   password -> the SEC authorized-service token
//   console  -> the `console_host` app setting
//   version  -> the `api_version` app setting (default 20.0)
//
// HTTP is used directly; QRadar returns a JSON error body { message, code,
// description, http_response:{code} }. NOTE: this uses the standard TLS stack,
// so the console must present a certificate the host trusts.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

export interface QRadarSettings {
  timeoutMs: number
  /** https://<console> (no trailing slash, no /api). */
  baseUrl: string | null
  version: string
}

export function readQRadarSettings(settings: Record<string, unknown>): QRadarSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawHost = settings.console_host
  let baseUrl: string | null = null
  if (typeof rawHost === 'string' && rawHost.trim()) {
    const h = rawHost.trim().replace(/\/+$/, '').replace(/\/api$/, '')
    baseUrl = /^https?:\/\//.test(h) ? h : `https://${h}`
  }
  const rawVersion = settings.api_version
  const version = typeof rawVersion === 'string' && rawVersion.trim() ? rawVersion.trim() : '20.0'
  return { timeoutMs, baseUrl, version }
}

export interface QRadarCredential {
  baseUrl: string
  token: string
  version: string
}

export function resolveQRadarCredential(credential: CredentialRef | null, settings: QRadarSettings): QRadarCredential | null {
  if (!credential) return null
  // The SEC token may be stored in password (preferred) or username.
  const token = (credential.password ?? credential.username ?? '').trim()
  const baseUrl = (settings.baseUrl ?? '').trim()
  if (!token || !baseUrl) return null
  return { baseUrl, token, version: settings.version }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable IBM QRadar credential — this app authenticates to the QRadar REST API with an ' +
  'authorized-service token. Store the token in the credential "password" field, and set the ' +
  'QRadar console host in the app\'s "Console Host" setting. The authorized service needs a role ' +
  'with reference-data (admin) permission.'

export interface QRadarResponse {
  status: number
  ok: boolean
  body: string
  transportError?: string
}

export type QRadarMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface DeployStatusResult {
  /** true when the deploy was accepted OR one is already running (both are non-fatal). */
  ok: boolean
  /** true when QRadar rejected a concurrent deploy (409 / code 1002) — staged changes
   * will be applied by the in-flight deploy, so callers treat this as success. */
  alreadyRunning: boolean
  message?: string
}

export class QRadarClient {
  private readonly cred: QRadarCredential
  private readonly timeoutMs: number

  constructor(opts: { cred: QRadarCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  async request(method: QRadarMethod, path: string, opts?: { range?: string; body?: unknown }): Promise<QRadarResponse> {
    const url = `${this.cred.baseUrl}/api${path.startsWith('/') ? path : `/${path}`}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = {
        SEC: this.cred.token,
        Version: this.cred.version,
        Accept: 'application/json',
      }
      if (opts?.range) headers.Range = opts.range
      const init: RequestInit = { method, headers, signal: controller.signal }
      if (opts?.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      const res = await fetch(url, init)
      const body = await res.text()
      return { status: res.status, ok: res.ok, body }
    } catch (err) {
      return { status: 0, ok: false, body: '', transportError: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  // --- Reference set operations ----------------------------------------------
  createSet(name: string, elementType: string): Promise<QRadarResponse> {
    return this.request('POST', `/reference_data/sets?name=${encodeURIComponent(name)}&element_type=${encodeURIComponent(elementType)}`)
  }
  getSet(name: string): Promise<QRadarResponse> {
    // Range pulls the whole value list (sets managed as code are small).
    return this.request('GET', `/reference_data/sets/${encodeURIComponent(name)}`, { range: 'items=0-9999' })
  }
  addValue(name: string, value: string): Promise<QRadarResponse> {
    return this.request('POST', `/reference_data/sets/${encodeURIComponent(name)}?value=${encodeURIComponent(value)}`)
  }
  deleteValue(name: string, value: string): Promise<QRadarResponse> {
    return this.request('DELETE', `/reference_data/sets/${encodeURIComponent(name)}/${encodeURIComponent(value)}`)
  }
  deleteSet(name: string): Promise<QRadarResponse> {
    return this.request('DELETE', `/reference_data/sets/${encodeURIComponent(name)}`)
  }

  // --- Staged-config deploy ---------------------------------------------------
  // Types under /staged_config/* (and network_hierarchy/staged_networks) only
  // STAGE their writes; POST /staged_config/deploy_status applies them. The deploy
  // is asynchronous (returns a status object with percent_complete) and single-
  // flight — a concurrent deploy is rejected with 409 / error code 1002. A caller
  // that just staged changes treats "already running" as success: the in-flight
  // deploy applies everything currently staged.
  async deployStagedConfig(type: 'INCREMENTAL' | 'FULL' = 'INCREMENTAL'): Promise<DeployStatusResult> {
    const resp = await this.request('POST', '/staged_config/deploy_status', { body: { type } })
    if (resp.ok || resp.status === 202) return { ok: true, alreadyRunning: false }
    const parsed = parseJson<{ code?: number; message?: string; description?: string }>(resp.body)
    if (resp.status === 409 || parsed?.code === 1002) {
      return { ok: true, alreadyRunning: true, message: 'A QRadar deploy is already in progress; staged changes will be applied by it.' }
    }
    return { ok: false, alreadyRunning: false, message: qradarErrorMessage(resp) }
  }
}

export function buildQRadarClient(cred: QRadarCredential, settings: QRadarSettings): QRadarClient {
  return new QRadarClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function qradarErrorMessage(res: QRadarResponse): string {
  if (res.transportError) return res.transportError
  const parsed = parseJson<{ message?: string; description?: string; code?: number }>(res.body)
  const msg = parsed?.description || parsed?.message
  if (msg) return parsed?.code ? `${msg} (code ${parsed.code})` : msg
  return res.body?.slice(0, 300) || `QRadar request failed (HTTP ${res.status})`
}
