// =============================================================================
// Snyk API client — speaks to BOTH the modern REST API and the legacy v1 API.
//
// Auth is a Snyk token sent as `Authorization: token <token>` (a service-account
// token is recommended for automation). Snyk runs two APIs in parallel and
// config is split across them:
//   - REST (https://<host>/rest): JSON:API, requires ?version=YYYY-MM-DD, and
//     Content-Type application/vnd.api+json on writes. Holds SAST/IaC settings,
//     service accounts, policies.
//   - v1   (https://<host>/v1):   plain JSON. Holds integrations, webhooks,
//     notification settings, ignores.
// Almost all config is org-scoped: REST paths use /orgs/{org_id}, v1 uses the
// SINGULAR /org/{org_id}. The org id is an app setting. Tokens are region-scoped;
// the component hostname selects the region host (api.snyk.io, api.eu.snyk.io …).
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status. Honors 429 with backoff.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000
const DEFAULT_HOST = 'api.snyk.io'
const DEFAULT_VERSION = '2024-10-15'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface SnykSettings {
  orgId: string | null
  groupId: string | null
  apiVersion: string
  timeoutMs: number
}

export function readSnykSettings(settings: Record<string, unknown>): SnykSettings {
  const rawOrg = settings.org_id
  const orgId = typeof rawOrg === 'string' && rawOrg.trim().length > 0 ? rawOrg.trim() : null

  const rawGroup = settings.group_id
  const groupId = typeof rawGroup === 'string' && rawGroup.trim().length > 0 ? rawGroup.trim() : null

  const rawVersion = settings.api_version
  const apiVersion = typeof rawVersion === 'string' && rawVersion.trim() ? rawVersion.trim() : DEFAULT_VERSION

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { orgId, groupId, apiVersion, timeoutMs }
}

/** Extract the Snyk API token from a Veltrix credential ("API token" or "password"). */
export function resolveSnykToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Snyk API token available — create a service-account token in Snyk (Settings > Service accounts) ' +
  'and store it in the credential "API token" field. Tokens are region-scoped, so use the region host ' +
  'that matches the token.'

export const MISSING_ORG_MESSAGE =
  'No Snyk organization id — set the "Organization ID" app setting (Snyk Settings > General > ' +
  'Organization ID). Most Snyk configuration is org-scoped.'

export interface SnykResponse {
  status: number
  ok: boolean
  body: string
}

export type SnykMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** JSON:API single/list envelope (REST). */
export interface JsonApiEnvelope<T = unknown> {
  data?: T
  links?: { next?: string; prev?: string; self?: string }
  errors?: Array<{ status?: string; title?: string; detail?: string; code?: string }>
  jsonapi?: unknown
}

export class SnykClient {
  private readonly restBase: string
  private readonly v1Base: string
  private readonly token: string
  private readonly orgId: string | null
  private readonly groupId: string | null
  private readonly apiVersion: string
  private readonly timeoutMs: number

  constructor(opts: { host: string; token: string; orgId: string | null; groupId: string | null; apiVersion: string; timeoutMs: number }) {
    this.restBase = `https://${opts.host}/rest`
    this.v1Base = `https://${opts.host}/v1`
    this.token = opts.token
    this.orgId = opts.orgId
    this.groupId = opts.groupId
    this.apiVersion = opts.apiVersion
    this.timeoutMs = opts.timeoutMs
  }

  get hasOrg(): boolean {
    return this.orgId !== null
  }

  /** REST org path prefix (`/orgs/{org_id}`); throws when no org id is set. */
  restOrgPath(): string {
    if (!this.orgId) throw new Error(MISSING_ORG_MESSAGE)
    return `/orgs/${this.orgId}`
  }

  /** v1 org path prefix (SINGULAR `/org/{org_id}`); throws when no org id is set. */
  v1OrgPath(): string {
    if (!this.orgId) throw new Error(MISSING_ORG_MESSAGE)
    return `/org/${this.orgId}`
  }

  /** A REST (JSON:API) request. Adds ?version and the vnd.api+json content type. */
  async rest(
    method: SnykMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<SnykResponse> {
    return this.send(this.restBase, method, path, { version: this.apiVersion, ...opts.query }, opts.body, 'application/vnd.api+json')
  }

  /** A v1 (plain JSON) request. */
  async v1(
    method: SnykMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<SnykResponse> {
    return this.send(this.v1Base, method, path, opts.query, opts.body, 'application/json')
  }

  /** GET every page of a REST collection, following `links.next`. */
  async restGetAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let res = await this.rest('GET', path, { query: { limit: 100, ...query } })
    let lastStatus = res.status
    let lastBody = res.body
    const maxPages = 100
    for (let page = 0; page < maxPages; page++) {
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const env = parseJson<JsonApiEnvelope<T[]>>(res.body)
      if (Array.isArray(env?.data)) items.push(...env!.data!)
      const next = env?.links?.next
      if (!next) break
      // links.next is a path (with query) relative to the REST base, or absolute.
      res = await this.sendNext(next)
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async sendNext(next: string): Promise<SnykResponse> {
    const url = next.startsWith('http') ? next : `${this.restBase}${next.startsWith('/') ? '' : '/'}${next}`
    return this.fetchUrl('GET', url, undefined, 'application/vnd.api+json')
  }

  private async send(
    base: string,
    method: SnykMethod,
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    body: unknown,
    contentType: string,
  ): Promise<SnykResponse> {
    const url = new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.fetchUrl(method, url.toString(), body, contentType)
  }

  private async fetchUrl(method: SnykMethod, url: string, body: unknown, contentType: string): Promise<SnykResponse> {
    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `token ${this.token}`,
            Accept: contentType,
            'Content-Type': contentType,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        })
        const text = await res.text()
        if (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
          attempts++
          clearTimeout(timer)
          await sleep(RATE_LIMIT_BACKOFF_MS)
          continue
        }
        return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

/** Build a client from a component hostname (the Snyk region API host), a credential and settings. */
export function buildSnykClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: SnykClient; host: string } | { error: string } {
  const token = resolveSnykToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  let host = (hostname ?? '').trim().toLowerCase()
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || DEFAULT_HOST

  const resolved = readSnykSettings(settings)
  return {
    client: new SnykClient({
      host,
      token,
      orgId: resolved.orgId,
      groupId: resolved.groupId,
      apiVersion: resolved.apiVersion,
      timeoutMs: resolved.timeoutMs,
    }),
    host,
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

/** Extract the `data` payload from a REST JSON:API envelope, or null. */
export function restResult<T>(res: SnykResponse): T | null {
  const env = parseJson<JsonApiEnvelope<T>>(res.body)
  return (env?.data ?? null) as T | null
}

/** Extract a human-readable error from a Snyk REST (JSON:API) or v1 error response. */
export function snykErrorMessage(res: SnykResponse): string {
  const rest = parseJson<JsonApiEnvelope>(res.body)
  if (Array.isArray(rest?.errors) && rest!.errors!.length > 0) {
    return rest!.errors!.map((e) => e.detail || e.title || e.code || 'error').join('; ')
  }
  const v1 = parseJson<{ message?: string; error?: string }>(res.body)
  if (v1?.message) return v1.message
  if (v1?.error) return v1.error
  return res.body || `HTTP ${res.status}`
}
