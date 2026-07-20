// =============================================================================
// Okta Management API client.
//
// Auth is an Okta API token (SSWS) sent on every request as
//     Authorization: SSWS <token>
// All routes are under `/api/v1`. Okta rate-limits with 429 + an
// `X-Rate-Limit-Reset` epoch-second header; this retries once on 429.
//
// Handlers run in-process in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency. It never
// throws on an HTTP error status — callers inspect `status` so they can tell a
// 404 (object absent) from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000

export interface OktaSettings {
  timeoutMs: number
}

export function readOktaSettings(settings: Record<string, unknown>): OktaSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

/**
 * Extract the Okta API token from a Veltrix credential.
 * Convention: the SSWS token in "API token" (preferred) or "password".
 */
export function resolveOktaToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Okta API token available — store an Okta API token (SSWS) in the credential "API token" ' +
  'field. Create one in the Okta Admin console under Security > API > Tokens; it inherits the ' +
  'permissions of the admin who created it, so use an admin scoped to what this app manages.'

export interface OktaResponse {
  status: number
  ok: boolean
  body: string
  /** `rel="next"` URL from the Link header, when the response is paginated. */
  nextUrl: string | null
}

export type OktaMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class OktaClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs: number }) {
    // Normalize to `https://<org>.okta.com/api/v1`.
    const trimmed = opts.baseUrl.replace(/\/+$/, '')
    this.baseUrl = /\/api\/v1$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: OktaMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<OktaResponse> {
    let res = await this.send(method, path, opts)

    if (res.status === 429) {
      const waitMs = rateLimitWaitMs(res.rateLimitResetEpoch)
      if (waitMs !== null && waitMs <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(waitMs)
        res = await this.send(method, path, opts)
      }
    }

    return { status: res.status, ok: res.ok, body: res.body, nextUrl: res.nextUrl }
  }

  /**
   * GET every page of a collection endpoint, following `rel="next"` Link
   * headers, and return the concatenated JSON arrays. Stops on the first error.
   */
  async getAll<T = unknown>(path: string): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    // `path` may be app-relative; after the first hop `nextUrl` is absolute.
    let next: string | null = path
    let absolute = false
    let lastStatus = 0
    let lastBody = ''
    while (next) {
      const res: OktaResponse = absolute
        ? await this.sendAbsolute('GET', next)
        : await this.request('GET', next)
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const page = parseJson<T[]>(res.body)
      if (Array.isArray(page)) items.push(...page)
      next = res.nextUrl
      absolute = true
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }

  private async send(
    method: OktaMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<OktaResponse & { rateLimitResetEpoch?: number }> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.fetchUrl(method, url.toString(), opts.body)
  }

  private async sendAbsolute(method: OktaMethod, absoluteUrl: string): Promise<OktaResponse & { rateLimitResetEpoch?: number }> {
    return this.fetchUrl(method, absoluteUrl, undefined)
  }

  private async fetchUrl(
    method: OktaMethod,
    url: string,
    body: unknown,
  ): Promise<OktaResponse & { rateLimitResetEpoch?: number }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `SSWS ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      const reset = res.headers.get('x-rate-limit-reset')
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        body: text,
        nextUrl: parseNextLink(res.headers.get('link')),
        rateLimitResetEpoch: reset ? Number(reset) : undefined,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** X-Rate-Limit-Reset is an epoch second; return ms to wait, capped elsewhere. */
function rateLimitWaitMs(resetEpoch: number | undefined): number | null {
  if (resetEpoch === undefined || !Number.isFinite(resetEpoch)) return null
  // Reset is absolute epoch seconds; Date.now() is unavailable in some contexts,
  // so fall back to a small fixed backoff when we cannot compute the delta.
  const nowMs = Date.now()
  const waitMs = resetEpoch * 1000 - nowMs
  return waitMs > 0 ? waitMs : 1000
}

/** Extract the `rel="next"` URL from a Link header, or null. */
function parseNextLink(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/i)
    if (m) return m[1]
  }
  return null
}

/** Build a client from a component hostname, a credential and app settings. */
export function buildOktaClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: OktaClient; baseUrl: string } | { error: string } {
  const token = resolveOktaToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = hostname?.trim()
  if (!host) {
    return {
      error:
        'No Okta org — register a component whose hostname is the Okta org domain ' +
        '(e.g. dev-12345.okta.com or acme.oktapreview.com).',
    }
  }

  const resolved = readOktaSettings(settings)
  const baseUrl = host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`

  return {
    client: new OktaClient({ baseUrl, token, timeoutMs: resolved.timeoutMs }),
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

/** Extract a human-readable error from an Okta error response body. */
export function oktaErrorMessage(res: OktaResponse): string {
  const parsed = parseJson<{
    errorSummary?: string
    errorCauses?: Array<{ errorSummary?: string }>
  }>(res.body)
  if (parsed?.errorSummary) {
    const causes = (parsed.errorCauses ?? [])
      .map((c) => c.errorSummary)
      .filter(Boolean)
      .join('; ')
    return causes ? `${parsed.errorSummary} (${causes})` : parsed.errorSummary
  }
  return res.body || `HTTP ${res.status}`
}
