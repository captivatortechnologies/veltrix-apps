// =============================================================================
// Teleport Proxy web API client.
//
// Teleport's primary automation surface is the Auth Service's gRPC API over
// mutual TLS — this is what `tctl`, Machine ID, and the official
// terraform-provider-teleport all speak (verified directly against
// gravitational/teleport's integrations/terraform/provider/provider.go, whose
// schema is `addr` + an identity file / cert-key-ca triple / native
// Machine-ID join, dialed with `google.golang.org/grpc`). That is not
// reachable from a plain in-process `fetch()` — there is no JSON/HTTP
// transcoding gateway for it, and hand-rolling protobuf wire encoding for a
// dozen undocumented-field-number services is not a responsible substitute for
// generated client code.
//
// What IS reachable from `fetch()`, and genuinely a JSON+YAML REST surface,
// is the Teleport **Proxy's web API** — the same `/v1/webapi/*` routes the
// Teleport Web UI itself calls to manage roles, auth connectors, trusted
// clusters, Machine ID bots, databases, and discovery configs. Verified
// directly against gravitational/teleport@master:
//   - lib/web/apiserver.go `bindDefaultEndpoints` — route table (methods below
//     cite the exact route each config type uses)
//   - lib/web/resources.go — roles / github connectors / trusted clusters are
//     sent and received as a full resource YAML string inside a
//     `{"content": "..."}` JSON envelope (`ui.ResourceItem`, `CreateResource`/
//     `UpdateResource`/`ExtractResourceAndValidate`)
//   - lib/web/machineid.go, lib/web/databases.go, lib/web/discoveryconfig.go —
//     structured JSON request/response bodies for bots, databases, discovery
//     configs
//   - lib/web/apiserver.go `createWebSession` / `AuthenticateRequest` and
//     lib/web/session/cookie.go — the login + bearer-token + session-cookie
//     contract this client implements below
//
// Auth: POST /v1/webapi/sessions/web with a local user's username, password,
// and (if that user has a TOTP device enrolled) the current TOTP code. WebAuthn
// cannot be satisfied headlessly, so a TOTP-enrolled automation user is the
// only second factor this client can drive — documented in README.md. The
// response carries a bearer token (`{"type":"bearer","token":"..."}`) AND sets
// a `__Host-session` cookie; per `AuthenticateRequest`, subsequent requests
// need BOTH the `Authorization: Bearer <token>` header and that cookie.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { generateTotp } from './totp'

const REQUEST_TIMEOUT_MS = 30_000
const SESSION_COOKIE_NAME = '__Host-session'

export interface TeleportSettings {
  /** Explicit `:site` override for cluster-scoped routes; auto-resolved via GET /v1/webapi/sites when unset. */
  clusterName: string | null
  timeoutMs: number
}

export function readTeleportSettings(settings: Record<string, unknown>): TeleportSettings {
  const rawCluster = settings.cluster_name
  const clusterName = typeof rawCluster === 'string' && rawCluster.trim().length > 0 ? rawCluster.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { clusterName, timeoutMs }
}

// --- Credential resolution ---------------------------------------------------

export interface TeleportCredentialBundle {
  password: string
  totpSecret: string | null
}

/**
 * The connection's secret field holds EITHER a bare password (only usable
 * when the local user has no second factor enrolled — uncommon and not
 * recommended for anything but a throwaway test cluster) OR a small JSON
 * bundle pairing the password with the base32 TOTP seed enrolled as that
 * user's OTP device:
 *
 *   {"password": "the-account-password", "totpSecret": "JBSWY3DPEHPK3PXP"}
 *
 * This mirrors the established pattern of bundling multiple secret values
 * into one platform credential field rather than inventing a new platform
 * credential shape — see apps/velociraptor/lib/velociraptorApi.ts, which
 * bundles a CA cert + client cert + client key the same way.
 */
export function parseCredentialBundle(raw: string): TeleportCredentialBundle {
  const trimmed = raw.trim()
  if (!trimmed) return { password: '', totpSecret: null }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { password?: unknown; totpSecret?: unknown }
      const password = typeof parsed.password === 'string' ? parsed.password.trim() : ''
      const totpSecret = typeof parsed.totpSecret === 'string' ? parsed.totpSecret.trim() : ''
      if (password) return { password, totpSecret: totpSecret || null }
    } catch {
      // Not valid JSON — fall through and treat the whole string as a bare password.
    }
  }

  return { password: trimmed, totpSecret: null }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Teleport credentials available — store the local automation user\'s username in the credential ' +
  '"Username" field, and its password in the "API token" field either alone (only if the cluster ' +
  'enforces no second factor) or as a JSON bundle {"password": "...", "totpSecret": "<base32 TOTP ' +
  'seed>"} pairing the password with that user\'s enrolled TOTP device secret.'

export interface ResolvedTeleportCredentials {
  username: string
  password: string
  totpSecret: string | null
}

export function resolveTeleportCredentials(credential: CredentialRef | null): ResolvedTeleportCredentials | null {
  if (!credential) return null
  const username = (credential.username || '').trim()
  const bundleSource = (credential.apiToken || credential.password || '').trim()
  if (!username || !bundleSource) return null

  const bundle = parseCredentialBundle(bundleSource)
  if (!bundle.password) return null

  return { username, password: bundle.password, totpSecret: bundle.totpSecret }
}

// --- HTTP plumbing ------------------------------------------------------------

export interface TeleportResponse {
  status: number
  ok: boolean
  body: string
}

export type TeleportMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

interface TeleportSession {
  token: string
  cookie: string
  expiresAtMs: number
}

/** Parse a JSON body, returning null instead of throwing on malformed/empty content. */
export function parseJson<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Best-effort human-readable error message from a Teleport API response body. */
export function teleportErrorMessage(res: TeleportResponse): string {
  const parsed = parseJson<{ error?: { message?: string } | string; message?: string }>(res.body)
  const errField = parsed?.error
  if (typeof errField === 'string' && errField) return errField
  if (errField && typeof errField === 'object' && errField.message) return errField.message
  if (parsed?.message) return parsed.message
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}

/** Extract the `__Host-session` cookie value from a fetch Response's Set-Cookie header(s). */
function extractSessionCookie(res: Response): string | null {
  type HeadersWithSetCookie = Headers & { getSetCookie?: () => string[] }
  const headers = res.headers as HeadersWithSetCookie
  const raw: string[] =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (() => {
          const single = headers.get('set-cookie')
          return single ? [single] : []
        })()

  for (const entry of raw) {
    const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`).exec(entry)
    if (match) return match[1]
  }
  return null
}

/**
 * Client for the Teleport Proxy's `/v1/webapi/*` JSON web API — see the module
 * comment above for what this is (and is not) and the exact sources it was
 * verified against.
 */
export class TeleportClient {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private readonly totpSecret: string | null
  private readonly timeoutMs: number
  private readonly clusterNameOverride: string | null
  private session: TeleportSession | null = null
  private cachedSiteName: string | null = null

  constructor(opts: {
    baseUrl: string
    username: string
    password: string
    totpSecret: string | null
    timeoutMs: number
    clusterName: string | null
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.username = opts.username
    this.password = opts.password
    this.totpSecret = opts.totpSecret
    this.timeoutMs = opts.timeoutMs
    this.clusterNameOverride = opts.clusterName
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * POST /v1/webapi/sessions/web — mints a bearer token + `__Host-session`
   * cookie. Body: `{"user", "pass", "second_factor_token"}` (the exact field
   * names of `lib/web/apiserver.go`'s `CreateSessionReq`); `second_factor_token`
   * is only sent when a TOTP seed is configured — Teleport's cluster auth
   * preference decides whether it's actually required.
   */
  private async login(): Promise<void> {
    const body: Record<string, unknown> = { user: this.username, pass: this.password }
    if (this.totpSecret) body.second_factor_token = generateTotp(this.totpSecret)

    const res = await this.fetchWithTimeout(`${this.baseUrl}/v1/webapi/sessions/web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()

    if (!res.ok) {
      const message = teleportErrorMessage({ status: res.status, ok: false, body: text })
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Teleport rejected the login (HTTP ${res.status}): ${message}. Check the username, password, ` +
            'and — if the cluster enforces a second factor — that the TOTP seed matches an enrolled device.',
        )
      }
      throw new Error(`Teleport login failed (HTTP ${res.status}): ${message}`)
    }

    const cookie = extractSessionCookie(res)
    if (!cookie) {
      throw new Error(
        `Teleport login succeeded but did not return a "${SESSION_COOKIE_NAME}" session cookie`,
      )
    }
    const parsed = parseJson<{ token?: string; expires_in?: number }>(text)
    if (!parsed?.token) {
      throw new Error('Teleport login succeeded but the response carried no bearer token')
    }

    const ttlSeconds = typeof parsed.expires_in === 'number' && parsed.expires_in > 0 ? parsed.expires_in : 60
    // Refresh a little before actual expiry so a slow request never straddles it.
    this.session = { token: parsed.token, cookie, expiresAtMs: Date.now() + Math.max(ttlSeconds - 10, 5) * 1000 }
  }

  private async ensureSession(): Promise<TeleportSession> {
    if (!this.session || Date.now() >= this.session.expiresAtMs) {
      await this.login()
    }
    return this.session as TeleportSession
  }

  /**
   * Resolve the `:site` path segment that cluster-scoped routes (Machine ID
   * bots, databases, discovery configs) need. Uses the `cluster_name` app
   * setting when set; otherwise resolves it once via GET /v1/webapi/sites
   * (`lib/web/ui/cluster.go`'s `Cluster{Name}`) and takes the first entry —
   * correct for the overwhelmingly common single (root) cluster deployment.
   */
  async resolveSite(): Promise<string> {
    if (this.clusterNameOverride) return this.clusterNameOverride
    if (this.cachedSiteName) return this.cachedSiteName

    const res = await this.request('GET', '/v1/webapi/sites')
    if (!res.ok) {
      throw new Error(`Failed to resolve the Teleport cluster/site name: ${teleportErrorMessage(res)}`)
    }
    const sites = parseJson<Array<{ name?: string }>>(res.body) ?? []
    const first = sites.find((s) => typeof s.name === 'string' && s.name.trim().length > 0)
    if (!first?.name) {
      throw new Error(
        'GET /v1/webapi/sites returned no clusters — set the "Cluster Name" app setting explicitly.',
      )
    }
    this.cachedSiteName = first.name
    return first.name
  }

  /** Issue an authenticated request, retrying once with a fresh login on a 401 (expired session). */
  async request(method: TeleportMethod, path: string, opts: { body?: unknown } = {}): Promise<TeleportResponse> {
    const attempt = async (retryOn401: boolean): Promise<TeleportResponse> => {
      const session = await this.ensureSession()
      const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${session.token}`,
          Cookie: `${SESSION_COOKIE_NAME}=${session.cookie}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })

      if (res.status === 401 && retryOn401) {
        this.session = null
        return attempt(false)
      }

      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    }

    return attempt(true)
  }
}

/** Build a client from a component hostname, a credential, and app settings. */
export function buildTeleportClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: TeleportClient; baseUrl: string } | { error: string } {
  const creds = resolveTeleportCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = hostname?.trim()
  if (!host) {
    return {
      error:
        'No Teleport Proxy address — register a component whose hostname is the Teleport Proxy address ' +
        '(e.g. teleport.example.com:443).',
    }
  }

  const resolved = readTeleportSettings(settings)
  const baseUrl = host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`

  return {
    client: new TeleportClient({
      baseUrl,
      username: creds.username,
      password: creds.password,
      totpSecret: creds.totpSecret,
      timeoutMs: resolved.timeoutMs,
      clusterName: resolved.clusterName,
    }),
    baseUrl,
  }
}
