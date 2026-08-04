// =============================================================================
// Trend Vision One public API (v3.0) client.
//
// Trend Vision One exposes a regional REST API. The connection endpoint /
// component hostname is the regional API host, e.g.
//   api.xdr.trendmicro.com          (United States)
//   api.eu.xdr.trendmicro.com       (Europe)
//   api.sg.xdr.trendmicro.com       (Singapore)
//   api.in.xdr.trendmicro.com       (India)
//   api.au.xdr.trendmicro.com       (Australia)
//   api.usgov.xdr.trendmicro.com    (US Government)
// Requests go to `https://<host>/v3.0/<path>`. Pick the host for the region your
// Trend Vision One console runs in. VERIFY the exact regional host against your
// live Vision One tenant (Administration -> API Keys shows the console region).
//
// Auth is a single Bearer token on every call (RFC 6750):
//   Authorization: Bearer <token>
// The token is a Trend Vision One API key generated in the console under
// Administration -> API Keys (tokens expire one year after creation by default).
// It is stored on the connection credential's `apiToken` (falling back to
// `password`). No username is required.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`/`json`.
//
// v0.3.0 added `patch()` (IAM account updates use PATCH, not POST) and the
// `*Beta()` method family (Cloud Risk Management custom rules hang off `/beta`,
// not `/v3.0` — see `API_BETA_PATH`).
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** All Trend Vision One public API paths hang off this version prefix. */
export const API_VERSION_PATH = '/v3.0'
/**
 * Cloud Risk Management custom compliance rules (`/cloudPosture/customRules`) hang
 * off this prefix instead of `/v3.0` — confirmed against the official Trend
 * `vision-one-mcp-server` Go client (trendmicro/vision-one-mcp-server,
 * internal/v1client/cloudposture.go). The `beta` prefix is Trend's own naming, not
 * a Veltrix designation — VERIFY it has not since graduated to `/v3.0` on your
 * tenant.
 */
export const API_BETA_PATH = '/beta'

export interface VisionOneSettings {
  timeoutMs: number
}

export function readVisionOneSettings(settings: Record<string, unknown>): VisionOneSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

/** Extract the Trend Vision One API token from a Veltrix credential. */
export function resolveVisionOneToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token || null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Trend Vision One credential — store your API key as the credential token. Generate an API key ' +
  'in the Trend Vision One console under Administration > API Keys, scoped to what this app manages, ' +
  'and attach it to this connection.'

export const MISSING_ENDPOINT_MESSAGE =
  'No Trend Vision One regional API host — register a connection whose endpoint is your regional API ' +
  'host (e.g. api.xdr.trendmicro.com for the US, api.eu.xdr.trendmicro.com for Europe). Pick the host ' +
  'matching your Vision One console region.'

/** A parsed Trend Vision One API response. `json` is the parsed body (null when absent/invalid). */
export interface VisionOneResponse {
  status: number
  ok: boolean
  json: unknown
  body: string
  /** Response headers, lowercased keys. Vision One returns created-resource ids on `location`. */
  headers: Record<string, string>
}

export class VisionOneClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` }
  }

  /** Read + parse a fetch Response into the shared VisionOneResponse shape. */
  private async finish(res: Response): Promise<VisionOneResponse> {
    const text = await res.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    return { status: res.status, ok: res.status >= 200 && res.status < 300, json, body: text, headers }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    basePath: string = API_VERSION_PATH,
  ): Promise<VisionOneResponse> {
    const headers: Record<string, string> = { ...this.authHeaders(), Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${basePath}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      return this.finish(res)
    } finally {
      clearTimeout(timer)
    }
  }

  /** GET a public-API `path` (e.g. `/threatintel/suspiciousObjects?top=1`). */
  async get(path: string): Promise<VisionOneResponse> {
    return this.request('GET', path)
  }

  /** POST a JSON `body` to a public-API `path`. Never throws on a non-2xx status. */
  async post(path: string, body: unknown): Promise<VisionOneResponse> {
    return this.request('POST', path, body)
  }

  /** PATCH a JSON `body` to a public-API `path` (e.g. `/iam/accounts/{id}`, partial update). */
  async patch(path: string, body: unknown): Promise<VisionOneResponse> {
    return this.request('PATCH', path, body)
  }

  /** DELETE a public-API `path` (e.g. `/response/customScripts/{id}`). Never throws on a non-2xx status. */
  async del(path: string): Promise<VisionOneResponse> {
    return this.request('DELETE', path)
  }

  /** GET a `beta`-prefixed path (e.g. `/cloudPosture/customRules`). See `API_BETA_PATH`. */
  async getBeta(path: string): Promise<VisionOneResponse> {
    return this.request('GET', path, undefined, API_BETA_PATH)
  }

  /** POST a JSON `body` to a `beta`-prefixed path. Never throws on a non-2xx status. */
  async postBeta(path: string, body: unknown): Promise<VisionOneResponse> {
    return this.request('POST', path, body, API_BETA_PATH)
  }

  /** PATCH a JSON `body` to a `beta`-prefixed path (partial update). Never throws on a non-2xx status. */
  async patchBeta(path: string, body: unknown): Promise<VisionOneResponse> {
    return this.request('PATCH', path, body, API_BETA_PATH)
  }

  /** DELETE a `beta`-prefixed path. Never throws on a non-2xx status. */
  async delBeta(path: string): Promise<VisionOneResponse> {
    return this.request('DELETE', path, undefined, API_BETA_PATH)
  }

  /**
   * POST a `multipart/form-data` body — Vision One's custom-script upload/update
   * (`/response/customScripts`) takes the metadata as form fields and the script
   * as a file part. The multipart boundary is set by fetch from the FormData, so
   * Content-Type is deliberately NOT set here. Never throws on a non-2xx status.
   */
  async postMultipart(
    path: string,
    fields: Record<string, string>,
    file: { field: string; filename: string; content: string; contentType?: string },
  ): Promise<VisionOneResponse> {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    form.append(
      file.field,
      new Blob([file.content], { type: file.contentType ?? 'text/plain' }),
      file.filename,
    )

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${API_VERSION_PATH}${path}`, {
        method: 'POST',
        headers: { ...this.authHeaders(), Accept: 'application/json' },
        body: form,
        signal: controller.signal,
      })
      return this.finish(res)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Connectivity / health probe: list one suspicious object. 200/2xx = reachable +
   * authenticated; 401/403 = bad token. VERIFY against a live Vision One tenant.
   */
  async health(): Promise<VisionOneResponse> {
    return this.get('/threatintel/suspiciousObjects?top=1')
  }
}

/**
 * Normalize a regional API host into an `https://<host>` base (no scheme, path or
 * trailing slash on input). The `/v3.0` prefix is added per-request by the client,
 * so it is stripped here if the operator pasted a fuller URL.
 */
export function buildVisionOneBaseUrl(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
  if (!host) return null
  return `https://${host}`
}

/** Build a client from the regional API host, a credential and settings. */
export function buildVisionOneClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: VisionOneClient; baseUrl: string } | { error: string } {
  const token = resolveVisionOneToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const baseUrl = buildVisionOneBaseUrl(hostname)
  if (!baseUrl) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readVisionOneSettings(settings)
  return {
    client: new VisionOneClient({ baseUrl, token, timeoutMs: resolved.timeoutMs }),
    baseUrl,
  }
}

/**
 * Human-readable message from a Trend Vision One error response. The v3.0 API wraps
 * errors as `{ error: { code, message } }`; fall back to the raw body/status. Never
 * throws. VERIFY the error envelope shape against a live Vision One tenant.
 */
export function visionOneErrorMessage(res: VisionOneResponse): string {
  const json = res.json as { error?: { code?: unknown; message?: unknown } } | null
  const err = json && typeof json === 'object' ? json.error : null
  if (err && typeof err === 'object') {
    const message = typeof err.message === 'string' ? err.message : ''
    const code = typeof err.code === 'string' ? err.code : ''
    if (message) return code ? `${message} (${code})` : message
  }
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

/**
 * Inspect a write response and return an error message when Vision One rejected it,
 * or null on success. NON-UNION `string | null` (the platform handler loader cannot
 * narrow discriminated unions).
 */
export function visionOneWriteError(res: VisionOneResponse): string | null {
  if (!res.ok) return visionOneErrorMessage(res)
  return null
}
