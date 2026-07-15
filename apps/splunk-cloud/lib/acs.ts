// =============================================================================
// Shared Admin Config Service (ACS) client for the Splunk Cloud app.
//
// ACS is Splunk Cloud Platform's supported administration API:
//   https://admin.splunk.com/{stack}/adminconfig/v2/...
//
// Authentication is a Splunk Cloud JWT bearer token created by an sc_admin
// user (Settings > Tokens in Splunk Web, or the ACS /tokens endpoint).
// ACS enforces a rate limit of 600 requests per 10 minutes per stack and
// returns errors as JSON bodies with `code` and `message` fields.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_ACS_BASE_URL = 'https://admin.splunk.com'
export const ACS_API_VERSION = 'adminconfig/v2'

export type SplunkCloudExperience = 'victoria' | 'classic'

export interface AcsSettings {
  baseUrl: string
  experience: SplunkCloudExperience
  timeoutMs: number
}

/** Read and normalize the app settings that drive ACS access. */
export function readAcsSettings(settings: Record<string, unknown>): AcsSettings {
  const rawBaseUrl = settings.acs_base_url
  const baseUrl =
    typeof rawBaseUrl === 'string' && rawBaseUrl.trim().length > 0
      ? rawBaseUrl.trim().replace(/\/+$/, '')
      : DEFAULT_ACS_BASE_URL

  const experience: SplunkCloudExperience =
    settings.experience === 'classic' ? 'classic' : 'victoria'

  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : 30

  return { baseUrl, experience, timeoutMs: timeoutSeconds * 1000 }
}

/**
 * Derive the ACS stack name from a component hostname.
 * Components may be registered as "mystack", "mystack.splunkcloud.com",
 * or a full URL — ACS expects the bare stack name in the path.
 */
export function resolveStackName(hostname: string): string {
  let host = hostname.trim()
  host = host.replace(/^https?:\/\//i, '')
  host = host.split('/')[0] ?? host
  host = host.split(':')[0] ?? host
  host = host.replace(/\.splunkcloudgc\.com$/i, '')
  host = host.replace(/\.splunkcloud\.com$/i, '')
  return host
}

/**
 * Extract the ACS bearer token from a Veltrix credential. Splunk Cloud's only
 * secret is the stack JWT, so accept it from the "API token" field (preferred)
 * OR the "password" field — the connection form defaults to username/password,
 * so users commonly paste the JWT there.
 */
export function resolveAcsToken(credential: CredentialRef | null): string | null {
  const token = (credential?.apiToken?.trim() || credential?.password?.trim() || '')
  return token.length > 0 ? token : null
}

export interface AcsRequestOptions {
  baseUrl: string
  stack: string
  token: string
  timeoutMs: number
}

export interface AcsResponse {
  status: number
  ok: boolean
  body: string
}

export type AcsMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/** Build a full ACS URL for a path like "/indexes" or "/access/hec/ipallowlists". */
export function acsUrl(opts: AcsRequestOptions, path: string): string {
  return `${opts.baseUrl}/${opts.stack}/${ACS_API_VERSION}${path}`
}

/**
 * Perform a single ACS request. Never throws on HTTP error statuses —
 * callers inspect `status` so they can distinguish 404 (missing resource),
 * 202 (async provisioning) and hard failures. Throws only on network errors
 * or timeout, which callers surface as deployment/check failures.
 */
export async function acsRequest(
  opts: AcsRequestOptions,
  method: AcsMethod,
  path: string,
  body?: unknown,
): Promise<AcsResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)

  try {
    const res = await fetch(acsUrl(opts, path), {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, ok: res.ok, body: text }
  } finally {
    clearTimeout(timer)
  }
}

export interface AcsUpload {
  /** Raw bytes sent verbatim as the request body. */
  body: Buffer | Uint8Array
  /** e.g. "application/octet-stream" (Victoria) or a multipart content type (Classic). */
  contentType: string
  /** Endpoint-specific headers — the AppInspect token and the legal ack. */
  headers?: Record<string, string>
}

/**
 * POST a RAW body to ACS.
 *
 * `acsRequest` is JSON-only, but app install is a binary upload: Victoria takes
 * the .tar.gz bytes directly, Classic takes a multipart body. Same URL model,
 * same timeout, same never-throw-on-status contract — only the body differs.
 */
export async function acsUpload(
  opts: AcsRequestOptions,
  path: string,
  upload: AcsUpload,
  method: AcsMethod = 'POST',
): Promise<AcsResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)

  try {
    const res = await fetch(acsUrl(opts, path), {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': upload.contentType,
        Accept: 'application/json',
        ...(upload.headers ?? {}),
      },
      body: upload.body as unknown as BodyInit,
      signal: controller.signal,
    })
    const text = await res.text()
    return { status: res.status, ok: res.ok, body: text }
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Human-readable message from an ACS error response ({code, message} body). */
export function acsErrorMessage(res: AcsResponse): string {
  const parsed = parseJson<{ code?: string; message?: string }>(res.body)
  if (parsed?.message) {
    return parsed.code ? `${parsed.code}: ${parsed.message}` : parsed.message
  }
  if (res.status === 429) {
    return 'HTTP 429: ACS rate limit exceeded (600 requests per 10 minutes) — retry later'
  }
  return `ACS returned HTTP ${res.status}`
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Index and HEC token creation are asynchronous: the POST returns 202 and
 * the resource only answers GET with 200 once provisioning completes
 * (until then ACS returns 404-index-not-found / 404-hec-not-found).
 * Polls a bounded number of times; returns the 200 response, a hard-failure
 * response, or null if still provisioning when attempts are exhausted.
 */
export async function pollUntilReady(
  opts: AcsRequestOptions,
  path: string,
  { attempts = 6, intervalMs = 5000 }: { attempts?: number; intervalMs?: number } = {},
): Promise<AcsResponse | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await acsRequest(opts, 'GET', path)
    if (res.status === 200) return res
    if (res.status !== 404 && res.status !== 202) return res
    await sleep(intervalMs)
  }
  return null
}

/** Split a comma/newline separated canvas value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}
