// =============================================================================
// JFrog Xray access seam.
//
// One path: HTTPS REST against the JFrog Platform's Xray REST API, rooted at
// `https://<host>/xray/api`. `<host>` is the JFrog Platform base URL (SaaS,
// e.g. `mycompany.jfrog.io`, or a self-hosted Artifactory/Xray front door),
// stored as the connection's component hostname.
//
// Auth is a JFrog Platform ACCESS TOKEN, sent as `Authorization: Bearer
// <token>` — the current, platform-recommended authentication method. The
// legacy `X-JFrog-Art-Api` API-key header reached End of Life at the end of
// Q4 2024 (new API keys can no longer even be created as of Artifactory
// 7.98) and is therefore NOT supported by this client:
//   https://docs.jfrog.com/user-management/docs/api-key
//   https://docs.jfrog.com/administration/docs/access-tokens
// The token is stored as the connection credential's `apiToken`; no username
// is required (a JFrog access token is self-contained).
//
// Security policies live under /xray/api/v2/policies (verified against the
// official JFrog Xray REST API reference — the v2 policy surface, which
// carries additional action fields over v1):
//   GET    /xray/api/v2/policies            list all policies      (Read Policies role)
//   GET    /xray/api/v2/policies/{name}     read one policy         (Read Policies role)
//   POST   /xray/api/v2/policies            create a policy         (Manage Policies role)
//   PUT    /xray/api/v2/policies/{name}     replace a policy (full) (Manage Policies role)
//   DELETE /xray/api/v2/policies/{name}     delete a policy         (Manage Policies role;
//                                            fails while the policy is still assigned to a watch)
// Docs:
//   https://jfrog.com/help/r/xray-rest-apis/get-policies
//   https://jfrog.com/help/r/xray-rest-apis/get-policy
//   https://jfrog.com/help/r/xray-rest-apis/create-policy
//   https://jfrog.com/help/r/xray-rest-apis/update-policy
//   https://jfrog.com/help/r/xray-rest-apis/delete-policy
// Success responses use an `{ "info": "..." }` envelope; errors use
// `{ "error": "..." }`. `PUT` requires the FULL policy body — Xray does not
// support a partial update.
//
// A policy's `watches[]` binds it to scanned repositories/builds — that
// binding is a SEPARATE Xray object (Watches) and is intentionally out of
// scope for this config type; see config-types/security-policies for the
// deferred-to-wave-2 note.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout,
// never throws on an HTTP error status, and honors 429 with backoff.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Settings ----------------------------------------------------------------

export interface XraySettings {
  timeoutMs: number
}

export function readXraySettings(settings: Record<string, unknown>): XraySettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

// --- Credentials ---------------------------------------------------------------

/** Extract the JFrog Platform access token from a Veltrix credential ("API token" or "password"). */
export function resolveXrayToken(credential: CredentialRef | null | undefined): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No JFrog access token available — generate an Access Token in the JFrog Platform ' +
  '(Administration > User Management > Access Tokens) scoped with the Xray "Manage Policies" ' +
  '(and "Read Policies") permission, then store it in the credential "Access token" field.'

export const MISSING_ENDPOINT_MESSAGE =
  'No JFrog Platform host configured — register a "jfrog-xray-instance" component whose hostname ' +
  'is your JFrog Platform base URL (e.g. mycompany.jfrog.io, or your self-hosted Artifactory/Xray host).'

// --- HTTP transport ------------------------------------------------------------

export interface XrayResponse {
  status: number
  ok: boolean
  body: string
}

export type XrayMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class XrayClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { host: string; token: string; timeoutMs: number }) {
    this.base = `https://${opts.host}/xray`
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  /** `https://<host>/xray` — the Xray API root (no trailing slash). */
  get baseUrl(): string {
    return this.base
  }

  /** One Xray REST call. `path` includes its own API version, e.g. `/api/v2/policies`. */
  async request(method: XrayMethod, path: string, body?: unknown): Promise<XrayResponse> {
    const url = `${this.base}${path}`
    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
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
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Timed out after ${this.timeoutMs / 1000}s connecting to ${new URL(url).host}`)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await this.request('GET', path)
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${xrayErrorMessage(res)}`)
    return parseJson<T>(res.body) as T
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request('POST', path, body)
    if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${xrayErrorMessage(res)}`)
    return parseJson<T>(res.body) as T
  }

  async putJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request('PUT', path, body)
    if (!res.ok) throw new Error(`PUT ${path} → HTTP ${res.status}: ${xrayErrorMessage(res)}`)
    return parseJson<T>(res.body) as T
  }

  /** DELETE a resource. Resolves normally on 404 (already gone) — callers may want idempotent deletes. */
  async deleteResource(path: string): Promise<XrayResponse> {
    return this.request('DELETE', path)
  }
}

/** Build a client from a component hostname (the JFrog Platform host), a credential and settings. */
export function buildXrayClient(
  hostname: string | undefined,
  credential: CredentialRef | null | undefined,
  settings: Record<string, unknown>,
): { client: XrayClient; host: string } | { error: string } {
  const token = resolveXrayToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = normalizeHost(hostname)
  if (!host) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readXraySettings(settings)
  return { client: new XrayClient({ host, token, timeoutMs: resolved.timeoutMs }), host }
}

/** Reduce a hostname to a bare JFrog Platform host: strips protocol, path and trailing slash. */
export function normalizeHost(hostname: string | undefined): string | null {
  const host = (hostname ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  return host.length > 0 ? host : null
}

// --- Shared helpers --------------------------------------------------------------

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/**
 * Extract a human-readable error from an Xray response. Xray error bodies are
 * `{ "error": "..." }`; a handful of endpoints instead echo `{ "message": "..." }`.
 * Falls back to the raw (truncated) body when neither shape parses.
 */
export function xrayErrorMessage(res: XrayResponse): string {
  const parsed = parseJson<{ error?: string; message?: string }>(res.body)
  if (parsed?.error) return parsed.error
  if (parsed?.message) return parsed.message
  const trimmed = (res.body ?? '').trim()
  if (!trimmed) return `HTTP ${res.status}`
  return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed
}
