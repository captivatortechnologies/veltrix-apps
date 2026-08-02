// =============================================================================
// Datadog API client.
//
// Datadog is a multi-region SaaS: every request goes to `https://api.<site>`,
// where `<site>` is the organization's Datadog site — e.g. `datadoghq.com`
// (US1, the default), `us3.datadoghq.com` (US3), `us5.datadoghq.com` (US5),
// `datadoghq.eu` (EU1), `ap1.datadoghq.com` (AP1), `ap2.datadoghq.com` (AP2),
// or `ddog-gov.com` (US1-FED). The base host is built by prefixing `api.` onto
// the site value — the same server template Datadog's own official API clients
// use (`https://{subdomain}.{site}`, subdomain `api`, default site
// `datadoghq.com`):
//   https://github.com/DataDog/datadog-api-client-typescript/blob/master/packages/datadog-api-client-common/servers.ts
// Site reference: https://docs.datadoghq.com/getting_started/site/
// Datadog periodically adds new sites, so `normalizeSite` accepts ANY site
// string rather than a hardcoded enum — a new region works without an app
// update.
//
// Auth is two STATIC keys sent as headers on every request (no token exchange,
// unlike an OAuth2 client-credentials app):
//   DD-API-KEY           — the organization's API key.
//   DD-APPLICATION-KEY   — an Application key scoped to a user's permissions.
// The Security Monitoring Rules API requires BOTH headers for every operation
// (list, get, create, update, delete) — verified per-endpoint against the
// official docs (see the citations in _shared.ts / deploy.ts). Key management:
// https://docs.datadoghq.com/account_management/api-app-keys/
//
// The connection stores: username = DD-API-KEY, apiToken = DD-APPLICATION-KEY;
// the connection's endpoint/hostname holds the bare Datadog SITE (e.g.
// "datadoghq.eu"), not a URL.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status — callers inspect `.ok` / `.status`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

/** The default Datadog site (US1) — used when a connection has none configured. */
export const DEFAULT_SITE = 'datadoghq.com'

/**
 * Well-known Datadog sites, for UI help text / documentation ONLY.
 * `normalizeSite` accepts any site string, so a site added after this app was
 * built still works. https://docs.datadoghq.com/getting_started/site/
 */
export const KNOWN_SITES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'datadoghq.com', label: 'US1 — datadoghq.com (default)' },
  { value: 'us3.datadoghq.com', label: 'US3 — us3.datadoghq.com' },
  { value: 'us5.datadoghq.com', label: 'US5 — us5.datadoghq.com' },
  { value: 'datadoghq.eu', label: 'EU1 — datadoghq.eu' },
  { value: 'ap1.datadoghq.com', label: 'AP1 — ap1.datadoghq.com' },
  { value: 'ap2.datadoghq.com', label: 'AP2 — ap2.datadoghq.com' },
  { value: 'ddog-gov.com', label: 'US1-FED — ddog-gov.com' },
]

/**
 * Normalize a connection's endpoint/hostname into a bare Datadog site value
 * (e.g. "datadoghq.eu"). Tolerates a full URL or an already-prefixed API host
 * ("api.datadoghq.eu") being pasted in by mistake. Empty input falls back to
 * the default US1 site.
 */
export function normalizeSite(raw: string | undefined | null): string {
  let site = (raw ?? '').trim().toLowerCase()
  if (!site) return DEFAULT_SITE
  site = site.replace(/^https?:\/\//, '')
  site = site.replace(/^api\./, '')
  site = site.replace(/\/.*$/, '')
  site = site.replace(/:\d+$/, '')
  return site || DEFAULT_SITE
}

/** `https://api.<site>` — the base URL for every Datadog REST call. */
export function buildApiBase(site: string): string {
  return `https://api.${site}`
}

export interface DatadogKeys {
  apiKey: string
  applicationKey: string
}

/** Pull the two static Datadog keys from a stored credential (username = API key, apiToken = Application key). */
export function resolveDatadogKeys(credential: CredentialRef | null | undefined): DatadogKeys | null {
  const apiKey = credential?.username?.trim()
  const applicationKey = credential?.apiToken?.trim()
  if (!apiKey || !applicationKey) return null
  return { apiKey, applicationKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Datadog API keys configured — create an API key and an Application key in Datadog ' +
  '(Organization Settings > API Keys and > Application Keys), then store the API key in the ' +
  'credential "username" field and the Application key in the "API token" field. The ' +
  'Application key must belong to a user with the security_monitoring_rules_read and ' +
  'security_monitoring_rules_write permissions.'

export const MISSING_SITE_MESSAGE =
  'No Datadog site configured — register a "datadog-org" component whose hostname is your ' +
  'Datadog site (e.g. "datadoghq.com", "datadoghq.eu", "us3.datadoghq.com").'

export interface DatadogResponse {
  status: number
  ok: boolean
  body: string
}

export type DatadogMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export class DatadogClient {
  private readonly base: string
  private readonly apiKey: string
  private readonly applicationKey: string
  private readonly timeoutMs: number

  constructor(opts: { site: string; keys: DatadogKeys; timeoutMs?: number }) {
    this.base = buildApiBase(opts.site)
    this.apiKey = opts.keys.apiKey
    this.applicationKey = opts.keys.applicationKey
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  get baseUrl(): string {
    return this.base
  }

  /**
   * One Datadog API request. Always sends BOTH DD-API-KEY and
   * DD-APPLICATION-KEY — every Security Monitoring Rules operation requires
   * both. Never throws on an HTTP error status; a network failure or timeout
   * is normalized into `{ status: 0, ok: false, body: <message> }` so callers
   * have one, non-throwing shape to branch on.
   */
  async request(
    method: DatadogMethod,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<DatadogResponse> {
    const url = new URL(`${this.base}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          'DD-API-KEY': this.apiKey,
          'DD-APPLICATION-KEY': this.applicationKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { status: 0, ok: false, body: `Timed out after ${this.timeoutMs / 1000}s connecting to ${url.host}` }
      }
      return { status: 0, ok: false, body: error instanceof Error ? error.message : 'Datadog request failed' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from a component hostname (the Datadog SITE), a credential and settings. */
export function buildDatadogClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null | undefined,
  settings: Record<string, unknown>,
): { client: DatadogClient; site: string; baseUrl: string } | { error: string } {
  const keys = resolveDatadogKeys(credential)
  if (!keys) return { error: MISSING_CREDENTIAL_MESSAGE }

  const site = normalizeSite(hostname)
  const timeoutMs = readTimeoutSetting(settings)
  const client = new DatadogClient({ site, keys, timeoutMs })
  return { client, site, baseUrl: client.baseUrl }
}

function readTimeoutSetting(settings: Record<string, unknown>): number {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : REQUEST_TIMEOUT_MS
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
 * Extract a human-readable error from a Datadog error response body. Datadog's
 * standard error envelope is `{ "errors": ["message", ...] }` across the v1/v2
 * APIs (confirmed for this API by
 * https://docs.datadoghq.com/api/latest/authentication/validate-api-key/, whose
 * documented 403 body is exactly this shape).
 */
export function datadogErrorMessage(res: DatadogResponse): string {
  const parsed = parseJson<{ errors?: unknown; error?: string }>(res.body)
  if (!parsed) return res.body || `HTTP ${res.status}`
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    return parsed.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ')
  }
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  return res.body || `HTTP ${res.status}`
}
