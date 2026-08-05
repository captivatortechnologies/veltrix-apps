// =============================================================================
// Exabeam New-Scale platform API client for the exabeam app.
//
// Auth: an Exabeam API Key (OAuth2 client_credentials grant against the
// platform's own token endpoint - NOT a third-party IdP):
//   Token:  POST https://api.<region>.exabeam.cloud/auth/v1/token
//           body (application/json): { client_id, client_secret, grant_type: "client_credentials" }
//   API:    https://api.<region>.exabeam.cloud/<product>/... e.g.
//           https://api.<region>.exabeam.cloud/correlation-rules/v2/rules
//           header: Authorization: Bearer <access_token>
// Verified directly against the Exabeam API reference (developers.exabeam.com,
// "Identity and Access > Get an access token" -
// https://developers.exabeam.com/exabeam/reference/get-access-token) and the
// Authentication guide (https://developers.exabeam.com/exabeam/docs/api-keys):
//   - the 10 regional hostnames (us-west/us-east/sg/jp/eu/au/ca/ch/sa/uk)
//   - the token endpoint path and its JSON (not form-encoded) request body
//   - the documented limits: tokens are valid ~4 hours and the guide
//     explicitly warns "Do NOT request a token every time an API call is
//     made" and to request at most ~6 tokens per key per 24 hours (which is
//     exactly one token per token lifetime) - so this client caches the
//     token for its full reported lifetime and only refreshes near expiry or
//     on a 401. The guide also documents per-IP rate limits (50 req/5 min for
//     the auth endpoint, 100 req/min for the public APIs), another reason to
//     never mint a token per request.
//
// Handlers run in-process in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency. request()
// never throws on an HTTP error status - callers inspect `status` so they can
// tell a 404 (object absent) from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** Refresh the cached token when less than this remains of its lifetime. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000
/** The auth guide documents ~4 hour (14400s) tokens; used when a response omits expires_in. */
const DEFAULT_TOKEN_TTL_SECONDS = 14_400

// --- Regions ------------------------------------------------------------------

/**
 * Exabeam New-Scale platform regions -> API hostname, from the Exabeam API
 * reference server list (every reference page enumerates the same 10 regional
 * servers, e.g. https://developers.exabeam.com/exabeam/reference/get-access-token).
 * A tenant is provisioned into exactly one region; there is no discovery
 * endpoint - the admin must know which region their tenant lives in.
 */
export const EXABEAM_REGIONS = {
  'us-west': { host: 'api.us-west.exabeam.cloud', label: 'US West' },
  'us-east': { host: 'api.us-east.exabeam.cloud', label: 'US East' },
  sg: { host: 'api.sg.exabeam.cloud', label: 'Singapore' },
  jp: { host: 'api.jp.exabeam.cloud', label: 'Japan' },
  eu: { host: 'api.eu.exabeam.cloud', label: 'European Union' },
  au: { host: 'api.au.exabeam.cloud', label: 'Australia' },
  ca: { host: 'api.ca.exabeam.cloud', label: 'Canada' },
  ch: { host: 'api.ch.exabeam.cloud', label: 'Switzerland' },
  sa: { host: 'api.sa.exabeam.cloud', label: 'South America' },
  uk: { host: 'api.uk.exabeam.cloud', label: 'United Kingdom' },
} as const

export type ExabeamRegion = keyof typeof EXABEAM_REGIONS

export const DEFAULT_EXABEAM_REGION: ExabeamRegion = 'us-west'

/** Prototype-safe region lookup - canvas/settings values are user input. */
function regionHost(region: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(EXABEAM_REGIONS, region)
    ? EXABEAM_REGIONS[region as ExabeamRegion].host
    : undefined
}

export function isValidExabeamRegion(region: string): region is ExabeamRegion {
  return Object.prototype.hasOwnProperty.call(EXABEAM_REGIONS, region)
}

export interface ExabeamSettings {
  region: ExabeamRegion
  timeoutMs: number
}

/** Read and normalize the app settings that drive Exabeam API access. */
export function readExabeamSettings(settings: Record<string, unknown>): ExabeamSettings {
  const rawRegion = typeof settings.region === 'string' ? settings.region.trim().toLowerCase() : ''
  const region: ExabeamRegion = isValidExabeamRegion(rawRegion) ? rawRegion : DEFAULT_EXABEAM_REGION

  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30

  return { region, timeoutMs: timeoutSeconds * 1000 }
}

// --- Credentials ---------------------------------------------------------------

export interface ExabeamApiKeyCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the Exabeam API Key from a Veltrix credential. Convention (mirrors
 * ping-identity / crowdstrike-edr): the Key in "username", the Secret in
 * "API token" (preferred) or "password" - both are shown once, at creation
 * time, under Settings > API Keys in the Exabeam console.
 */
export function resolveExabeamCredentials(
  credential: CredentialRef | null,
): ExabeamApiKeyCredentials | null {
  if (!credential) return null
  const clientId = credential.username?.trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Exabeam API Key available - store the key in the credential "username" field and its secret ' +
  'in the "API token" field. Create one under Settings > API Keys in the Exabeam console and assign ' +
  'it a permission set that covers Correlation Rules (read/write).'

// --- HTTP client ----------------------------------------------------------------

export interface ExabeamResponse {
  status: number
  ok: boolean
  body: string
}

/** Exabeam's standard error envelope: { errors: [{ code, message, messageParams?, fields? }], traceId }. */
export interface ExabeamErrorEntry {
  code?: string
  message?: string
  fields?: string[]
}

export interface ExabeamErrorEnvelope {
  errors?: ExabeamErrorEntry[]
  traceId?: string
  // Some endpoints (the token endpoint) use the OAuth2 shape instead.
  error?: string
  error_description?: string
}

export type ExabeamMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface CachedToken {
  accessToken: string
  expiresAt: number
}

// Tokens live ~4 hours and the auth guide caps a key at ~6 token requests per
// 24 hours - cache per (host, clientId+secret) so every handler invocation in
// a pipeline run (validate -> deploy -> healthCheck -> driftDetect) reuses one
// token instead of re-authenticating.
const tokenCache = new Map<string, CachedToken>()

export class ExabeamClient {
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number

  constructor(opts: {
    region: ExabeamRegion
    credentials: ExabeamApiKeyCredentials
    timeoutMs: number
  }) {
    const host = EXABEAM_REGIONS[opts.region].host
    this.baseUrl = `https://${host}`
    this.clientId = opts.credentials.clientId
    this.clientSecret = opts.credentials.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  private cacheKey(): string {
    return `${this.baseUrl}|${this.clientId}|${this.clientSecret}`
  }

  /** POST {baseUrl}/auth/v1/token - JSON client_credentials grant. */
  private async authenticate(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey())
    if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.accessToken
    }

    const res = await this.rawFetch(`${this.baseUrl}/auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
      }),
    })

    if (!res.ok) {
      throw new Error(
        `Exabeam authentication failed against ${this.baseUrl}: ${exabeamErrorMessage(res)}. ` +
          'Check the API Key/Secret, and that the selected region matches the tenant.',
      )
    }

    const parsed = parseJson<{ access_token?: string; expires_in?: number }>(res.body)
    if (!parsed?.access_token) {
      throw new Error(`Exabeam authentication returned no access_token (HTTP ${res.status})`)
    }

    const ttlSeconds =
      typeof parsed.expires_in === 'number' && parsed.expires_in > 0
        ? parsed.expires_in
        : DEFAULT_TOKEN_TTL_SECONDS
    tokenCache.set(this.cacheKey(), {
      accessToken: parsed.access_token,
      expiresAt: Date.now() + ttlSeconds * 1000,
    })
    return parsed.access_token
  }

  /**
   * Perform a request against the API host. Never throws on an HTTP error
   * status - callers inspect `status`. Retries once on 401 (expired/revoked
   * token). Throws on network errors, timeout, and authentication failure.
   */
  async request(
    method: ExabeamMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<ExabeamResponse> {
    let token = await this.authenticate()
    let res = await this.send(method, path, token, opts)

    if (res.status === 401) {
      tokenCache.delete(this.cacheKey())
      token = await this.authenticate()
      res = await this.send(method, path, token, opts)
    }

    return res
  }

  private async send(
    method: ExabeamMethod,
    path: string,
    token: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<ExabeamResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const res = await this.rawFetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    return res
  }

  private async rawFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<ExabeamResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build an Exabeam client from a credential (API Key/Secret) and app settings
 * (region, timeout). Returns a descriptive `error` instead of throwing so
 * every handler can surface one consistent message. There is no per-tenant id
 * in the URL - a tenant is fully addressed by its region + API Key - so,
 * unlike ping-identity/google-secops, this never reads `component.hostname`.
 */
export function buildExabeamClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: ExabeamClient; region: ExabeamRegion } | { error: string } {
  const credentials = resolveExabeamCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readExabeamSettings(settings)
  return {
    client: new ExabeamClient({
      region: resolved.region,
      credentials,
      timeoutMs: resolved.timeoutMs,
    }),
    region: resolved.region,
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

/** Extract a human-readable error from an Exabeam error response body. */
export function exabeamErrorMessage(res: ExabeamResponse): string {
  const parsed = parseJson<ExabeamErrorEnvelope>(res.body)
  if (parsed?.errors?.length) {
    return parsed.errors
      .map((e) => (e.fields?.length ? `${e.message} (fields: ${e.fields.join(', ')})` : e.message))
      .filter(Boolean)
      .join('; ')
  }
  if (parsed?.error_description || parsed?.error) {
    return parsed.error_description ?? parsed.error ?? `HTTP ${res.status}`
  }
  return res.body || `HTTP ${res.status}`
}

/** Deterministic JSON stringify with recursively sorted object keys - for drift comparisons. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
