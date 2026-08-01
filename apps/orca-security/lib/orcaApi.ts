// =============================================================================
// Orca Security (agentless CNAPP / CSPM) REST API client.
//
// Auth is a long-lived Orca API token carried in the Authorization header with a
// "Token " prefix (NOT "Bearer"):
//
//   Authorization: Token <api_token>
//   Content-Type:  application/json
//
// This is the scheme Orca's own Terraform provider uses (api_client.Execute sets
// `authorization: Token <token>`), so it is the verified write path — there is no
// api_token -> access_token exchange for this surface. The token is stored as the
// Veltrix connection credential's apiToken.
//
// Base URL is a fixed regional endpoint (default https://api.orcasecurity.io; EU
// tenants use https://api.eu.orcasecurity.io). Paths are absolute and already
// carry the "/api" prefix (e.g. /api/sonar/rules).
//
// Handlers run in-process, so this uses fetch with an AbortController timeout,
// never throws on an HTTP error status, and returns a NON-UNION result record so
// callers narrow without help from the compiler or the platform's handler loader.
// =============================================================================

import type { ComponentRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** Default Orca REST API base (US tenants). EU tenants use api.eu.orcasecurity.io. */
export const DEFAULT_API_ENDPOINT = 'https://api.orcasecurity.io'

const REQUEST_TIMEOUT_MS = 30_000

export const MISSING_CREDENTIAL_MESSAGE =
  'No Orca API token — create one in Orca under Settings > Users & Permissions > API ' +
  '(Add API Token) and store it in the credential\'s "API token" field.'

// --- Settings ----------------------------------------------------------------

export interface OrcaSettings {
  apiEndpoint: string
  timeoutMs: number
}

export function readOrcaSettings(settings: Record<string, unknown>): OrcaSettings {
  const rawEndpoint = settings.api_endpoint
  const apiEndpoint =
    typeof rawEndpoint === 'string' && /^https?:\/\//i.test(rawEndpoint.trim())
      ? rawEndpoint.trim()
      : DEFAULT_API_ENDPOINT

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { apiEndpoint, timeoutMs }
}

// --- Base URL resolution -----------------------------------------------------

/**
 * Reduce a host/URL to a bare `https://<host>` base: strips protocol, any path
 * (incl. a trailing /api), a trailing slash and a port-only artifact. Returns
 * null when nothing usable remains.
 */
export function normalizeApiBase(hostOrUrl: string | undefined | null): string | null {
  let host = (hostOrUrl ?? '').trim()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\/+$/, '')
    .trim()
  if (!host) return null
  return `https://${host}`
}

/**
 * Resolve the Orca API base URL for a connection. A per-connection endpoint (the
 * component hostname) wins so different tenants/regions can each point at their
 * own host; otherwise the app-level `api_endpoint` setting (default US) is used.
 */
export function resolveOrcaBaseUrl(
  hostname: string | undefined | null,
  settings: Record<string, unknown>,
): string {
  return (
    normalizeApiBase(hostname) ??
    normalizeApiBase(readOrcaSettings(settings).apiEndpoint) ??
    DEFAULT_API_ENDPOINT
  )
}

// --- Credentials -------------------------------------------------------------

/** The Orca API token from a Veltrix credential (apiToken, or password fallback). */
export function resolveOrcaToken(credential: CredentialRef | null | undefined): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

/** The Orca Authorization header. `Token ` prefix — never `Bearer`. */
export function buildAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Token ${token}` }
}

// --- Transport ---------------------------------------------------------------

/**
 * One Orca REST call's outcome. NON-UNION: every field is always present so a
 * handler reads `.error` / `.status` / `.data` without control-flow narrowing.
 *   - `error` is non-null for a network failure, a timeout, or a non-2xx status.
 *   - `data` is the parsed JSON body (null when the body is empty or non-JSON).
 */
export interface OrcaResponse<T = unknown> {
  status: number
  ok: boolean
  data: T | null
  error: string | null
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Trim an HTTP error body to a short single line for messages. */
function bodySummary(body: string): string {
  const trimmed = (body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return 'no response body'
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed
}

export class OrcaClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  get endpoint(): string {
    return this.baseUrl
  }

  /**
   * Execute one REST request against `<baseUrl><path>`. `path` is absolute and
   * carries the "/api" prefix (e.g. /api/sonar/rules). Never throws on an HTTP
   * error status — inspect `.error` / `.status`.
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
    path: string,
    body?: unknown,
  ): Promise<OrcaResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...buildAuthHeader(this.token),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      const ok = res.status >= 200 && res.status < 300
      if (!ok) {
        return { status: res.status, ok, data: null, error: `HTTP ${res.status}: ${bodySummary(text)}` }
      }
      return { status: res.status, ok, data: parseJson<T>(text), error: null }
    } catch (err) {
      return {
        status: 0,
        ok: false,
        data: null,
        error: err instanceof Error ? err.message : 'Orca request failed',
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from a component hostname, a credential and settings. NON-UNION-ish result. */
export function buildOrcaClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null | undefined,
  settings: Record<string, unknown>,
): { client: OrcaClient; baseUrl: string } | { error: string } {
  const token = resolveOrcaToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const baseUrl = resolveOrcaBaseUrl(hostname, settings)
  const { timeoutMs } = readOrcaSettings(settings)
  return { client: new OrcaClient({ baseUrl, token, timeoutMs }), baseUrl }
}
