// =============================================================================
// Cortex XSOAR REST API client.
//
// Auth is an API key sent in the `Authorization` header (the raw key value, not
// a Bearer/ApiToken prefix — this is XSOAR's convention). Two deployment shapes
// are supported from one client:
//
//   - Cortex XSOAR 6.x (on-prem server): base URL is the server FQDN,
//     `https://<fqdn>`, and only the `Authorization: <api-key>` header is sent.
//   - Cortex XSOAR 8 / the Cortex platform: the same `Authorization: <api-key>`
//     header PLUS `x-xdr-auth-id: <api-key-id>`, and the server API is reached
//     through the API gateway host under the `/xsoar` base path.
//
// The presence of the numeric API-key id (the `auth_id` app setting) is what
// selects XSOAR-8 mode: when set, the extra header is added and the default base
// path becomes `/xsoar`. An explicit `api_base_path` setting overrides the path
// for on-prem-8 / custom deployments.
//
// The XSOAR server API returns bare JSON (an array for `/lists` and
// `/incidenttype`, an envelope `{ data, total }` for `/jobs/search`). HTTP
// status is meaningful (>=400 = failure); the error body is JSON with a
// `detail`/`error`/`title`, or occasionally plain text.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`. 429s are
// retried with a fixed backoff.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface XsoarSettings {
  /** The API-key id (XSOAR 8 / Cortex). When set, enables XSOAR-8 auth + base path. */
  authId: string | null
  /** Explicit base-path override (e.g. "/xsoar"). Null = auto by auth mode. */
  apiBasePath: string | null
  timeoutMs: number
}

export function readXsoarSettings(settings: Record<string, unknown>): XsoarSettings {
  const rawAuthId = settings.auth_id
  const authId =
    typeof rawAuthId === 'string' && rawAuthId.trim().length > 0
      ? rawAuthId.trim()
      : typeof rawAuthId === 'number' && Number.isFinite(rawAuthId)
        ? String(rawAuthId)
        : null

  const rawBasePath = settings.api_base_path
  const apiBasePath =
    typeof rawBasePath === 'string' && rawBasePath.trim().length > 0 ? normalizeBasePath(rawBasePath) : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { authId, apiBasePath, timeoutMs }
}

/** Normalize a base path to a leading-slash, no-trailing-slash segment ("" stays ""). */
function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Extract the XSOAR API key from a Veltrix credential ("API token" or "password"). */
export function resolveXsoarApiKey(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const key = (credential.apiToken ?? credential.password ?? '').trim()
  return key.length > 0 ? key : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Cortex XSOAR API key available — create an API key in XSOAR (Settings > Integrations > API Keys) ' +
  'and store it in the credential "API token" field. For Cortex XSOAR 8 / the Cortex platform, also set ' +
  'the "API Key ID" (auth_id) app setting to the key\'s numeric id.'

export interface XsoarResponse {
  status: number
  ok: boolean
  body: string
}

export type XsoarMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** The `{ data, total }` envelope returned by search endpoints such as /jobs/search. */
export interface XsoarSearchEnvelope<T = unknown> {
  data?: T[] | null
  total?: number
}

export class XsoarClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly authId: string | null
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; apiKey: string; authId: string | null; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.apiKey = opts.apiKey
    this.authId = opts.authId
    this.timeoutMs = opts.timeoutMs
  }

  /** True when configured for Cortex XSOAR 8 / the Cortex platform (auth id present). */
  get isXsoar8(): boolean {
    return this.authId !== null
  }

  async request(
    method: XsoarMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<XsoarResponse> {
    let res = await this.send(method, path, opts)
    let attempts = 0
    while (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS)
      res = await this.send(method, path, opts)
      attempts++
    }
    return res
  }

  /**
   * GET a JSON resource and parse it. Non-union `{ ok, value, status, body, error }`
   * (all fields always present) so callers narrow without help from the compiler
   * or the platform handler loader.
   */
  async getJson<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; value: T | null; status: number; body: string; error: string | null }> {
    const res = await this.request('GET', path, { query })
    if (!res.ok) {
      return { ok: false, value: null, status: res.status, body: res.body, error: xsoarErrorMessage(res) }
    }
    const parsed = parseJsonValue<T>(res.body)
    return { ok: true, value: parsed.value, status: res.status, body: res.body, error: parsed.error }
  }

  private async send(
    method: XsoarMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<XsoarResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      Authorization: this.apiKey,
      Accept: 'application/json',
    }
    if (this.authId !== null) headers['x-xdr-auth-id'] = this.authId
    // Only advertise a JSON body when there is one — a bodyless request that
    // still sets Content-Type is rejected by some gateways.
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

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
}

/**
 * Build a client from a component hostname (the XSOAR server FQDN, or the Cortex
 * API gateway host for XSOAR 8), a credential and settings. Returns a discriminated
 * `{ client, serverUrl } | { error }` at the boundary — deploy/health handlers
 * check `'error' in built` exactly once, immediately.
 */
export function buildXsoarClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: XsoarClient; serverUrl: string } | { error: string } {
  const apiKey = resolveXsoarApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = (hostname ?? '').trim()
  if (!host) {
    return {
      error:
        'No Cortex XSOAR server — register a component whose hostname is the XSOAR server FQDN ' +
        '(e.g. xsoar.acme.com), or, for Cortex XSOAR 8, the Cortex API gateway host ' +
        '(e.g. api-acme.xdr.us.paloaltonetworks.com).',
    }
  }

  const resolved = readXsoarSettings(settings)
  const cleaned = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const basePath =
    resolved.apiBasePath !== null ? resolved.apiBasePath : resolved.authId !== null ? '/xsoar' : ''
  const baseUrl = `https://${cleaned}${basePath}`

  return {
    client: new XsoarClient({
      baseUrl,
      apiKey,
      authId: resolved.authId,
      timeoutMs: resolved.timeoutMs,
    }),
    serverUrl: `https://${cleaned}`,
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

/**
 * Parse a JSON body into a non-union `{ value, error }` (both fields always
 * present). Preferred over `parseJson` inside handlers because it never forces
 * the caller to narrow a discriminated union.
 */
export function parseJsonValue<T>(body: string): { value: T | null; error: string | null } {
  if (!body) return { value: null, error: null }
  try {
    return { value: JSON.parse(body) as T, error: null }
  } catch {
    return { value: null, error: 'Response was not valid JSON' }
  }
}

/** Extract a human-readable error from an XSOAR error response. */
export function xsoarErrorMessage(res: XsoarResponse): string {
  const parsed = parseJson<{ detail?: string; error?: string; title?: string; message?: string }>(res.body)
  if (parsed && typeof parsed === 'object') {
    const detail = parsed.detail || parsed.error || parsed.title || parsed.message
    if (detail && String(detail).trim()) return String(detail).trim()
  }
  const body = (res.body ?? '').trim()
  if (body) return body.length > 300 ? `${body.slice(0, 297)}...` : body
  return `HTTP ${res.status}`
}
