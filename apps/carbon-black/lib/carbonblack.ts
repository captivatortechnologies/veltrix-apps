// =============================================================================
// VMware Carbon Black Cloud (CBC) API client.
//
// Auth is an API key sent as a single header:
//   X-Auth-Token: <API Secret Key>/<API ID>   (secret first, then id)
// The base host is per-region (a setting) and most endpoints carry the org key
// as a path segment. Reputation overrides list via a POST _search with a
// start/rows offset model.
//
// Convention for the Veltrix credential:
//   username -> API ID
//   password -> API Secret Key
//   base_url -> the `base_url` app setting (region host)
//   org_key  -> the `org_key` app setting
//
// Rate limiting is HTTP 429 keyed per source IP — on 429 the client waits the
// Retry-After and retries once (retrying inside the window extends the penalty,
// so it does not hammer).
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000
export const DEFAULT_PAGE_ROWS = 100

export interface CbSettings {
  timeoutMs: number
  baseUrl: string | null
  orgKey: string | null
}

export function readCbSettings(settings: Record<string, unknown>): CbSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawBase = settings.base_url
  let baseUrl: string | null = null
  if (typeof rawBase === 'string' && rawBase.trim()) {
    const b = rawBase.trim().replace(/\/+$/, '')
    baseUrl = /^https?:\/\//.test(b) ? b : `https://${b}`
  }
  const rawOrg = settings.org_key
  const orgKey = typeof rawOrg === 'string' && rawOrg.trim() ? rawOrg.trim().replace(/[<>{}]/g, '') : null
  return { timeoutMs, baseUrl, orgKey }
}

export interface CbCredential {
  baseUrl: string
  orgKey: string
  apiId: string
  apiSecret: string
}

export function resolveCbCredential(credential: CredentialRef | null, settings: CbSettings): CbCredential | null {
  if (!credential) return null
  const apiId = (credential.username ?? '').trim()
  const apiSecret = (credential.password ?? '').trim()
  const baseUrl = (settings.baseUrl ?? '').trim()
  const orgKey = (settings.orgKey ?? '').trim()
  if (!apiId || !apiSecret || !baseUrl || !orgKey) return null
  return { baseUrl, orgKey, apiId, apiSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Carbon Black Cloud credential — this app authenticates with a CBC API key. Store the ' +
  'API ID in the credential "username" field and the API Secret Key in "password", and set the ' +
  'region base URL (e.g. https://defense.conferdeploy.net) and the Org Key in the app\'s settings. ' +
  'The API key needs a Custom access level granting org.reputations CREATE/READ/DELETE.'

export interface CbResponse {
  status: number
  ok: boolean
  body: string
  transportError?: string
}

export type CbMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class CbClient {
  private readonly cred: CbCredential
  private readonly timeoutMs: number

  constructor(opts: { cred: CbCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  /** X-Auth-Token is the secret first, then the id. */
  private authToken(): string {
    return `${this.cred.apiSecret}/${this.cred.apiId}`
  }

  async request(method: CbMethod, path: string, body?: unknown): Promise<CbResponse> {
    const url = path.startsWith('http') ? path : `${this.cred.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'X-Auth-Token': this.authToken(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await res.text()
        if (res.status === 429 && attempt === 0) {
          const retryAfter = Number(res.headers.get('Retry-After'))
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS) : 2000)
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

  get(path: string): Promise<CbResponse> {
    return this.request('GET', path)
  }
  post(path: string, body?: unknown): Promise<CbResponse> {
    return this.request('POST', path, body)
  }
  put(path: string, body?: unknown): Promise<CbResponse> {
    return this.request('PUT', path, body)
  }
  delete(path: string): Promise<CbResponse> {
    return this.request('DELETE', path)
  }

  /** The org-scoped reputation-overrides base path. */
  overridesPath(): string {
    return `/appservices/v6/orgs/${this.cred.orgKey}/reputations/overrides`
  }

  /** The org-scoped data-forwarder configs base path. */
  dataForwardersPath(): string {
    return `/data_forwarder/v2/orgs/${this.cred.orgKey}/configs`
  }

  /** The org-scoped asset-groups base path. */
  assetGroupsPath(): string {
    return `/asset_groups/v1/orgs/${this.cred.orgKey}/groups`
  }

  /** The org-scoped device-control base path for a sub-collection (approvals / blocks). */
  deviceControlPath(sub: 'approvals' | 'blocks'): string {
    return `/device_control/v3/orgs/${this.cred.orgKey}/${sub}`
  }

  /** The org-scoped watchlist-manager shared-reports base path. */
  watchlistReportsPath(): string {
    return `/threathunter/watchlistmgr/v3/orgs/${this.cred.orgKey}/reports`
  }

  /** The org-scoped policy-service base path. */
  policiesPath(): string {
    return `/policyservice/v1/orgs/${this.cred.orgKey}/policies`
  }

  /** The org-scoped Users base path (read-only lookup — this app never creates/edits users). */
  usersPath(): string {
    return `/appservices/v6/orgs/${this.cred.orgKey}/users`
  }

  /** The org-scoped Access Profiles and Grants base path. */
  grantsPath(): string {
    return `/access/v2/orgs/${this.cred.orgKey}/grants`
  }

  /** This org's `org_ref` URN, as used in a grant body. */
  orgRefUrn(): string {
    return `psc:org:${this.cred.orgKey}`
  }

  /** Page any CBC `_search` collection (start/rows) at `basePath` until num_found. */
  async searchAllAt<T = unknown>(
    basePath: string,
    criteria: Record<string, unknown> = {},
    opts: { rows?: number; sortField?: string; sortOrder?: 'asc' | 'desc'; maxPages?: number } = {}
  ): Promise<{ ok: boolean; items: T[]; lastError?: CbResponse }> {
    const rows = opts.rows ?? DEFAULT_PAGE_ROWS
    const maxPages = opts.maxPages ?? 40
    const items: T[] = []
    let start = 0
    let numFound = Infinity
    for (let page = 0; page < maxPages && start < numFound; page++) {
      const body: Record<string, unknown> = { criteria, start, rows }
      if (opts.sortField) {
        body.sort_field = opts.sortField
        body.sort_order = opts.sortOrder ?? 'asc'
      }
      const res = await this.post(`${basePath}/_search`, body)
      if (!res.ok) return { ok: false, items, lastError: res }
      const parsed = parseJson<{ num_found?: number; results?: T[] }>(res.body)
      const results = parsed?.results ?? []
      items.push(...results)
      numFound = parsed?.num_found ?? items.length
      if (results.length === 0) break
      start += rows
    }
    return { ok: true, items }
  }

  /** Page a reputation-override _search (start/rows) until num_found. */
  async searchAll<T = unknown>(criteria: Record<string, unknown> = {}, rows = DEFAULT_PAGE_ROWS, maxPages = 40): Promise<{ ok: boolean; items: T[]; lastError?: CbResponse }> {
    return this.searchAllAt<T>(this.overridesPath(), criteria, { rows, maxPages, sortField: 'create_time', sortOrder: 'asc' })
  }
}

export function buildCbClient(cred: CbCredential, settings: CbSettings): CbClient {
  return new CbClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function cbErrorMessage(res: CbResponse): string {
  if (res.transportError) return res.transportError
  const parsed = parseJson<{ message?: string; error_code?: string; description?: string }>(res.body)
  const msg = parsed?.message || parsed?.description || parsed?.error_code
  return msg || res.body?.slice(0, 300) || `Carbon Black request failed (HTTP ${res.status})`
}
