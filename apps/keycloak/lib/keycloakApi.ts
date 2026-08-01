// =============================================================================
// Keycloak Admin REST API access seam.
//
// One path: HTTPS REST against the Keycloak server. Self-hosted Keycloak commonly
// ships a self-signed certificate, so the transport tolerates untrusted certs
// (same posture as misp's mispApi / security-onion's soConsole) via node:https
// with rejectUnauthorized:false — flip it on with the `verify_tls` setting.
//
// Auth is an OAuth2 admin access token obtained from the token endpoint, then
// carried as `Authorization: Bearer <token>`:
//   POST <host>/realms/{authRealm}/protocol/openid-connect/token
//     grant_type=client_credentials  client_id=<clientId>  client_secret=<secret>   (primary)
//     grant_type=password            client_id=admin-cli   username/password         (alternate)
//
// Convention for the Veltrix credential:
//   username -> admin service-account client-id (client-credentials) OR admin user (password)
//   apiToken -> the client secret (client-credentials); when absent, `password` +
//               `username` drive the password grant against the `admin-cli` client.
//
// Admin base: <host>/admin/realms/{realm}/  (clients live at .../clients).
//
// Cited & verified against the official Keycloak Admin REST API docs
// (www.keycloak.org/docs-api/latest/rest-api) and the server-development guide.
// The token flow + endpoint paths are confirmed; the exact ClientRepresentation
// field surface should still be verified against a live Keycloak.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_KEYCLOAK_PORT = 443
export const DEFAULT_REALM = 'master'
/** Public admin client used for the password grant when no client secret is set. */
export const DEFAULT_ADMIN_CLI_CLIENT = 'admin-cli'

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the Keycloak server (no trailing slash). Prefers an explicit URL. */
export function buildKeycloakUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = Number(component.port) || DEFAULT_KEYCLOAK_PORT
  return `https://${resolveHost(component, connectivity, provider)}${port === 443 ? '' : `:${port}`}`
}

/** Normalize a raw endpoint/host into an https base URL with no trailing slash. */
export function normalizeBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  return withScheme.replace(/\/+$/, '')
}

/** The realm whose clients this app manages (the {realm} path segment). */
export function resolveRealm(settings: Record<string, unknown> | undefined): string {
  const v = settings?.realm
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_REALM
}

/** The realm that issues the admin token (where the service account / admin lives). */
export function resolveAuthRealm(settings: Record<string, unknown> | undefined): string {
  const v = settings?.auth_realm
  return typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_REALM
}

/** Enforce a valid TLS cert only when the `verify_tls` setting is explicitly true. */
export function resolveVerifyTls(settings: Record<string, unknown> | undefined): boolean {
  return settings?.verify_tls === true
}

export interface KeycloakResponse {
  status: number
  ok: boolean
  body: string
  /** Selected response headers (e.g. `location` from a 201 create). */
  headers: Record<string, string | string[] | undefined>
}

/**
 * One HTTPS request that (by default) tolerates Keycloak's self-signed certificate.
 * Uses node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. Never throws on an HTTP error status — callers inspect `status`.
 */
export function keycloakRequest(
  url: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
    verifyTls?: boolean
  } = {},
): Promise<KeycloakResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: init.verifyTls === true, // self-signed tolerated unless verify_tls
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({
            status,
            ok: status >= 200 && status < 300,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${u.host}`)))
    if (init.body) req.write(init.body)
    req.end()
  })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

// --- Admin token -------------------------------------------------------------

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/**
 * Resolve the grant this credential drives. Client-credentials is primary
 * (username = service-account client-id, apiToken = client secret); when no secret
 * is present but a username + password are, fall back to the password grant against
 * the public `admin-cli` client. Returns null when nothing usable is set.
 */
export function resolveGrant(credential: CredentialRef | null): URLSearchParams | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const secret = (credential.apiToken ?? '').trim()
  const password = (credential.password ?? '').trim()

  if (clientId && secret) {
    return new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret })
  }
  if (clientId && password) {
    return new URLSearchParams({
      grant_type: 'password',
      client_id: DEFAULT_ADMIN_CLI_CLIENT,
      username: clientId,
      password,
    })
  }
  return null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Keycloak admin credential — this app obtains an admin token via OAuth2. For the ' +
  'primary (client-credentials) grant, store the admin service-account client-id in the ' +
  'credential "username" field and its client secret in "apiToken". Alternatively, store an ' +
  'admin username in "username" and the password in "password" for the password grant. The ' +
  'client/user needs the realm-management "manage-clients" role on the managed realm.'

export interface AdminToken {
  token?: string
  /** Seconds until expiry, as reported by the token endpoint. */
  expiresIn?: number
  error?: string
  status?: number
}

/**
 * Obtain an admin access token from
 *   POST <base>/realms/{authRealm}/protocol/openid-connect/token
 * Returns `{ error }` (never throws) so callers can distinguish an auth failure
 * (bad secret / role) from a network error.
 */
export async function fetchAdminToken(
  base: string,
  authRealm: string,
  credential: CredentialRef | null,
  opts: { timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<AdminToken> {
  const form = resolveGrant(credential)
  if (!form) return { error: MISSING_CREDENTIAL_MESSAGE }

  const url = `${base}/realms/${encodeURIComponent(authRealm)}/protocol/openid-connect/token`
  try {
    const res = await keycloakRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: opts.timeoutMs,
      verifyTls: opts.verifyTls,
    })
    const parsed = parseJson<TokenResponse>(res.body)
    if (!res.ok || !parsed?.access_token) {
      const detail = parsed?.error_description || parsed?.error || `HTTP ${res.status}`
      return { error: `Admin token request failed: ${detail}`, status: res.status }
    }
    return { token: parsed.access_token, expiresIn: parsed.expires_in, status: res.status }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'token request error' }
  }
}

// --- Admin REST client -------------------------------------------------------

export type AdminMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Thin authenticated client over the Keycloak Admin REST API. Caches the bearer
 * token for the lifetime of one handler run (refreshing ~30s before expiry). All
 * paths are relative to `<base>/admin/realms/<realm>`.
 */
export class KeycloakAdminClient {
  private readonly base: string
  private readonly realm: string
  private readonly authRealm: string
  private readonly credential: CredentialRef | null
  private readonly timeoutMs: number
  private readonly verifyTls: boolean
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(opts: {
    base: string
    realm: string
    authRealm: string
    credential: CredentialRef | null
    timeoutMs?: number
    verifyTls?: boolean
  }) {
    this.base = opts.base
    this.realm = opts.realm
    this.authRealm = opts.authRealm
    this.credential = opts.credential
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.verifyTls = opts.verifyTls ?? false
  }

  get managedRealm(): string {
    return this.realm
  }

  private async ensureToken(): Promise<{ token?: string; error?: string }> {
    if (this.token && Date.now() < this.tokenExpiresAt - 30_000) return { token: this.token }
    const res = await fetchAdminToken(this.base, this.authRealm, this.credential, {
      timeoutMs: this.timeoutMs,
      verifyTls: this.verifyTls,
    })
    if (res.error || !res.token) return { error: res.error ?? 'no token' }
    this.token = res.token
    this.tokenExpiresAt = Date.now() + (res.expiresIn ?? 60) * 1000
    return { token: this.token }
  }

  /** `path` is relative to the managed realm base, e.g. `/clients?clientId=web`. */
  async request(method: AdminMethod, path: string, body?: unknown): Promise<KeycloakResponse> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) {
      return { status: 0, ok: false, body: auth.error ?? 'no token', headers: {} }
    }
    const url = `${this.base}/admin/realms/${encodeURIComponent(this.realm)}${path}`
    return keycloakRequest(url, {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      verifyTls: this.verifyTls,
    })
  }

  get(path: string): Promise<KeycloakResponse> {
    return this.request('GET', path)
  }
  post(path: string, body: unknown): Promise<KeycloakResponse> {
    return this.request('POST', path, body)
  }
  put(path: string, body: unknown): Promise<KeycloakResponse> {
    return this.request('PUT', path, body)
  }
  delete(path: string): Promise<KeycloakResponse> {
    return this.request('DELETE', path)
  }
}

/** Build an admin client from a handler context's component/credential/settings. */
export function buildAdminClient(opts: {
  component: ComponentRef
  connectivity: ConnectivityRef | null
  connectivityProvider?: ProviderLike
  credential: CredentialRef | null
  settings: Record<string, unknown>
  timeoutMs?: number
}): KeycloakAdminClient {
  return new KeycloakAdminClient({
    base: buildKeycloakUrl(opts.component, opts.connectivity, opts.connectivityProvider),
    realm: resolveRealm(opts.settings),
    authRealm: resolveAuthRealm(opts.settings),
    credential: opts.credential,
    timeoutMs: opts.timeoutMs,
    verifyTls: resolveVerifyTls(opts.settings),
  })
}
