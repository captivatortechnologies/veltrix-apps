// =============================================================================
// Tenable Vulnerability Management (tenable.io) API client.
//
// Auth is a static key pair sent on every request — no token exchange, unlike
// the Falcon app's OAuth2:
//     X-ApiKeys: accessKey=<accessKey>; secretKey=<secretKey>
//
// Handlers run IN-PROCESS in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency. It never
// throws on an HTTP error status — callers inspect `status` so they can tell a
// 404 (object absent) from a real failure — and retries once on 429 using the
// Retry-After header.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** Tenable Vulnerability Management is served from a single global endpoint. */
export const DEFAULT_TENABLE_BASE_URL = 'https://cloud.tenable.com'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000

export interface TenableSettings {
  baseUrl: string
  timeoutMs: number
}

/** Read and normalize the app settings that drive Tenable access. */
export function readTenableSettings(settings: Record<string, unknown>): TenableSettings {
  const rawBaseUrl = settings.api_base_url
  const baseUrl =
    typeof rawBaseUrl === 'string' && rawBaseUrl.trim().length > 0
      ? rawBaseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_TENABLE_BASE_URL

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { baseUrl, timeoutMs }
}

export interface TenableApiKeys {
  accessKey: string
  secretKey: string
}

/**
 * Extract the API key pair from a Veltrix credential.
 * Convention: access key in "username", secret key in "API token".
 */
export function resolveTenableCredentials(credential: CredentialRef | null): TenableApiKeys | null {
  if (!credential) return null
  const accessKey = credential.username?.trim()
  const secretKey = (credential.apiToken ?? credential.password ?? '').trim()
  if (!accessKey || !secretKey) return null
  return { accessKey, secretKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Tenable API keys available — store the access key in the credential "username" field ' +
  'and the secret key in the "API token" field (create a key pair under Settings > My Account > ' +
  'API Keys in Tenable Vulnerability Management).'

export interface TenableResponse {
  status: number
  ok: boolean
  body: string
}

export type TenableMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class TenableClient {
  private readonly baseUrl: string
  private readonly keys: TenableApiKeys
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; keys: TenableApiKeys; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.keys = opts.keys
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: TenableMethod,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
    } = {},
  ): Promise<TenableResponse> {
    let res = await this.send(method, path, opts)

    if (res.status === 429) {
      const waitMs = retryAfterMs(res.retryAfterSeconds)
      if (waitMs !== null && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(waitMs)
        res = await this.send(method, path, opts)
      }
    }

    return { status: res.status, ok: res.ok, body: res.body }
  }

  private async send(
    method: TenableMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<TenableResponse & { retryAfterSeconds?: number }> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          'X-ApiKeys': `accessKey=${this.keys.accessKey}; secretKey=${this.keys.secretKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const body = await res.text()
      const retryAfter = res.headers.get('retry-after')
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        body,
        retryAfterSeconds: retryAfter ? Number(retryAfter) : undefined,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Retry-After is seconds; returns ms, or null when absent/unparseable. */
function retryAfterMs(retryAfterSeconds: number | undefined): number | null {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) return null
  return Math.max(0, retryAfterSeconds * 1000)
}

/** Build a client from a component hostname, a credential and app settings. */
export function buildTenableClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: TenableClient; baseUrl: string } | { error: string } {
  const keys = resolveTenableCredentials(credential)
  if (!keys) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readTenableSettings(settings)
  // A component hostname overrides the default endpoint (e.g. an FedRAMP host);
  // otherwise every tenant uses the one global cloud endpoint.
  const host = hostname?.trim()
  const baseUrl =
    host && host.length > 0
      ? host.startsWith('http')
        ? host.replace(/\/+$/, '')
        : `https://${host.replace(/\/+$/, '')}`
      : resolved.baseUrl

  return {
    client: new TenableClient({ baseUrl, keys, timeoutMs: resolved.timeoutMs }),
    baseUrl,
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

/** Extract a human-readable error from a Tenable error response body. */
export function tenableErrorMessage(res: TenableResponse): string {
  const parsed = parseJson<{ error?: string; message?: string }>(res.body)
  return parsed?.error || parsed?.message || res.body || `HTTP ${res.status}`
}
