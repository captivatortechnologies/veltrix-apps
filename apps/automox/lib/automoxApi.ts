// =============================================================================
// Automox Console API client.
//
// Base URL is FIXED — Automox is a single global console:
//   https://console.automox.com/api
//
// Auth is a Bearer API key sent on every request:
//   Authorization: Bearer <api key>
//
// Organization scoping: almost every endpoint this app uses (list/create
// policies, read/update/delete a policy, list users) requires the tenant's
// numeric Organization ID as the `o` query parameter, e.g.
//   GET /policies?o=9999
// `GET /orgs` is the one exception — it lists every organization the API key
// can see WITHOUT an `o` param, which makes it the best connectivity probe
// (it validates the key AND lets the caller cross-check the configured org id
// without already trusting it).
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status — callers inspect `status` so they
// can tell a 404 (object absent) from a real failure. A 429 is retried with a
// short backoff (Automox does not document a Retry-After header).
//
// Verified against the official OpenAPI description published in the Automox
// Console Python SDK (swagger-codegen generated, MIT):
//   https://github.com/AutomoxCommunity/automox-console-sdk-python/blob/main/specs/ax_console.yaml
//   (servers: https://console.automox.com/api; securitySchemes.bearerAuth: http/bearer;
//   GET/POST /policies and GET/PUT/DELETE /policies/{id} all declare `o` as a
//   required integer query parameter; GET /orgs declares no `o` parameter.)
// Error body shape `{ errors: string[] }` per the spec's shared Error /
// Unauthorized / NotFound / RateLimit response components.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** Fixed base URL — Automox is a single global console (no per-tenant host). */
export const AUTOMOX_API_BASE = 'https://console.automox.com/api'

const REQUEST_TIMEOUT_MS = 30_000
/** Automox caps `/policies` and `/orgs` list pages at 500 (`limit`, 0-based `page`). */
export const PAGE_LIMIT = 500
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000

export const MISSING_CREDENTIAL_MESSAGE =
  'No Automox API key available — generate one in the Automox Console under Settings > API Keys, ' +
  'then store it in the credential "API token" field.'

export const MISSING_ORG_MESSAGE =
  'No Automox Organization ID configured — store it in the credential "username" field. Find your ' +
  'Organization ID in the Automox Console URL (console.automox.com/console/organization/<id>/...) or ' +
  'via GET /orgs.'

/** Extract the Automox API key from a Veltrix credential (apiToken preferred, password fallback). */
export function resolveApiKey(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const key = (credential.apiToken ?? credential.password ?? '').trim()
  return key.length > 0 ? key : null
}

/**
 * The Automox Organization ID — a positive integer, sent as the `o` query
 * parameter on org-scoped endpoints. Carried on the connection credential's
 * `username` field (the same "identifier lives in username" convention this
 * repo uses for JumpCloud's optional multi-tenant org id), but REQUIRED here
 * since almost every Automox endpoint this app calls needs it.
 */
export function resolveOrgId(credential: CredentialRef | null): number | null {
  const raw = (credential?.username ?? '').trim()
  if (!/^\d+$/.test(raw)) return null
  const id = Number.parseInt(raw, 10)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** Resolve the per-request timeout from app settings (seconds -> ms). */
export function readTimeoutMs(settings: Record<string, unknown>): number {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : REQUEST_TIMEOUT_MS
}

export interface AutomoxResponse {
  status: number
  ok: boolean
  body: string
}

export type AutomoxMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class AutomoxClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  readonly orgId: number
  private readonly timeoutMs: number

  constructor(opts: { apiKey: string; orgId: number; timeoutMs?: number; baseUrl?: string }) {
    this.baseUrl = (opts.baseUrl ?? AUTOMOX_API_BASE).replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.orgId = opts.orgId
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
  }

  /**
   * Perform one request. `orgScoped` (default true) appends `o=<orgId>` to the
   * query string — pass `orgScoped: false` for the handful of endpoints (e.g.
   * `GET /orgs`) that do not take (or need) an Organization ID.
   */
  async request(
    method: AutomoxMethod,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
      orgScoped?: boolean
    } = {},
  ): Promise<AutomoxResponse> {
    const orgScoped = opts.orgScoped ?? true
    const url = new URL(`${this.baseUrl}${path}`)
    if (orgScoped) url.searchParams.set('o', String(this.orgId))
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: this.headers(),
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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

  /**
   * GET every page of an org-scoped list endpoint (`/policies`, `/users`),
   * following Automox's `page` (0-based) + `limit` (max 500) pagination, and
   * return the concatenated bare JSON array. Stops on the first non-ok
   * response or a short page (fewer than `limit` rows).
   */
  async listAllPaged<T = unknown>(
    path: string,
    extraQuery: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let page = 0
    let lastStatus = 0
    let lastBody = ''
    // Hard cap the walk so a misbehaving endpoint can never loop forever.
    for (let i = 0; i < 1000; i++) {
      const res = await this.request('GET', path, { query: { ...extraQuery, page, limit: PAGE_LIMIT } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const rows = parseJson<T[]>(res.body)
      if (!Array.isArray(rows) || rows.length === 0) break
      items.push(...rows)
      if (rows.length < PAGE_LIMIT) break
      page++
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }
}

/** Build a client from a credential and app settings. */
export function buildAutomoxClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: AutomoxClient } | { error: string } {
  const apiKey = resolveApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }
  const orgId = resolveOrgId(credential)
  if (!orgId) return { error: MISSING_ORG_MESSAGE }
  return { client: new AutomoxClient({ apiKey, orgId, timeoutMs: readTimeoutMs(settings) }) }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from an Automox `{ errors: string[] }` response body. */
export function automoxErrorMessage(res: AutomoxResponse): string {
  const parsed = parseJson<{ errors?: string[] }>(res.body)
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) return parsed.errors.join('; ')
  return res.body || `HTTP ${res.status}`
}
