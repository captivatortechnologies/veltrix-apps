// =============================================================================
// pfSense REST API package client.
//
// pfSense CE ships NO REST API of its own — every write in this app goes
// through the widely-used third-party "pfSense REST API" package
// (pfSense-pkg-RESTAPI, formerly jaredhendrickson13/pfsense-api; renamed and
// now maintained under the pfrest org). It is a REAL INSTALL PREREQUISITE on
// the customer's pfSense box (System > Package Manager > Available Packages >
// search "RESTAPI") — never assume it is already present. See the Setup
// Guide and README for install instructions.
//   Package: https://github.com/pfrest/pfSense-pkg-RESTAPI
//   Docs:    https://pfrest.org/  (Authentication & Authorization, API Reference / Swagger)
//
// This client targets the package's v2 API (base path /api/v2, configurable
// via the `api_base_path` setting though only v2 is tested). Chosen over
// pfSense Plus's newer official Netgate API because: (1) it works on both
// pfSense CE and Plus — Plus's official API is Plus-only and the customer's
// box may be CE; (2) it is the de-facto community standard (actively
// maintained, versioned releases tracking each pfSense release, built-in
// Swagger/OpenAPI docs); (3) it is FOSS and independently verifiable against
// its own PHP source, which is how every fact below was confirmed (source
// citations inline) rather than guessed from prose docs.
//
// Response envelope — verified against RESTAPI/Core/Response.inc and the
// documented JWT example (`{"code":200,"status":"ok","response_id":"SUCCESS",
// "data":{"token":"..."}}`, https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/):
// every response is `{ code, status, response_id, message, data, _links? }`.
// A failure keeps the same shape with a non-2xx `code` and a `response_id`
// like "INVALID_HOST_ALIAS_ADDRESS" plus a human `message`.
//
// Authentication — verified against
// https://pfrest.org/AUTHENTICATION_AND_AUTHORIZATION/ — three methods exist
// (Basic, API key, JWT); this app supports the two credential-friendly ones,
// auto-detected from which secret the operator stored (same pattern as this
// codebase's Check Point client — no separate "auth method" setting needed):
//   - API key  (credential.apiToken set): header `X-API-Key: <key>`.
//     Keys are minted via the webConfigurator (System > REST API > Keys) or
//     `POST /api/v2/auth/key`, and carry the privileges of the user that
//     generated them.
//   - JWT      (credential.username + password set, no apiToken): this
//     client itself calls `POST /api/v2/auth/jwt` with HTTP Basic (the local
//     webConfigurator username/password — LDAP/RADIUS backends are NOT
//     supported for this) to mint a short-lived token (default 1h), then
//     sends `Authorization: Bearer <token>` on every subsequent call. The
//     token is cached for the lifetime of this client instance only — one
//     mint per pipeline invocation, matching this codebase's "one session per
//     handler call" posture (see the Check Point client's module doc).
//
// TLS: pfSense ships a self-signed certificate on the webConfigurator (and
// therefore the REST API, which shares its listener) until an administrator
// installs a CA-signed one — tolerated by default via a dedicated node:https
// Agent gated by the `verify_tls` setting, same posture as this codebase's
// other self-hosted-appliance clients (Check Point, Cisco ISE).
// =============================================================================

import { Agent, request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_PORT = 443
export const DEFAULT_API_BASE_PATH = '/api/v2'
const DEFAULT_TIMEOUT_MS = 30_000

type ProviderLike = { config?: Record<string, unknown> | null } | null

// --- Settings ----------------------------------------------------------------

export interface PfsenseSettings {
  port: number
  verifyTls: boolean
  /** e.g. "/api/v2" — only v2 is implemented/tested; see manifest setting help text. */
  apiBasePath: string
  timeoutMs: number
}

export function readPfsenseSettings(settings: Record<string, unknown>): PfsenseSettings {
  const rawPort = settings.port
  const port = typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT

  const rawBasePath = settings.api_base_path
  const apiBasePath = typeof rawBasePath === 'string' && rawBasePath.trim() ? rawBasePath.trim() : DEFAULT_API_BASE_PATH

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS

  return { port, verifyTls: settings.verify_tls === true, apiBasePath, timeoutMs }
}

// --- Endpoint resolution -------------------------------------------------------

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** Base URL for the REST API package, e.g. `https://fw.example.com:443/api/v2` (no trailing slash). */
export function buildPfsenseUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  settings: PfsenseSettings,
  provider?: ProviderLike,
): string {
  const host = resolveHost(component, connectivity, provider)
  const port = Number(component.port) || settings.port
  return `https://${host}:${port}${settings.apiBasePath}`
}

// --- Credentials ---------------------------------------------------------------

/** Either an API key (X-API-Key) or a local webConfigurator username/password (to mint a JWT). */
export type PfsenseCredential = { kind: 'api_key'; apiKey: string } | { kind: 'jwt'; username: string; password: string }

/**
 * Resolve the pfSense REST API credential: an API key in `apiToken` takes
 * priority (System > REST API > Keys, or `POST /api/v2/auth/key`); otherwise
 * `username` + `password` — the LOCAL webConfigurator account used to mint a
 * JWT via `POST /api/v2/auth/jwt`. LDAP/RADIUS-backed accounts cannot be used
 * for JWT/Basic auth per the package's own docs.
 */
export function resolvePfsenseCredential(credential: CredentialRef | null): PfsenseCredential | null {
  if (!credential) return null
  const apiKey = (credential.apiToken ?? '').trim()
  if (apiKey) return { kind: 'api_key', apiKey }
  const username = (credential.username ?? '').trim()
  const password = credential.password ?? ''
  if (username && password) return { kind: 'jwt', username, password }
  return null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable pfSense credential — this app authenticates to the REST API package with either an ' +
  'API key (store it in the credential "API token" field) or a local webConfigurator administrator ' +
  'username + password (used to mint a short-lived JWT). LDAP/RADIUS-backed accounts cannot be used.'

export const MISSING_HOST_MESSAGE =
  'No pfSense endpoint configured for this connection — set the firewall hostname (and HTTPS port, ' +
  'default 443) when adding the connection.'

export function hasUsableCredential(credential: CredentialRef | null | undefined): boolean {
  return resolvePfsenseCredential(credential ?? null) !== null
}

// --- Response envelope ---------------------------------------------------------

/** Every REST API package response — verified against RESTAPI/Core/Response.inc. */
export interface PfsenseEnvelope<T = unknown> {
  code: number
  status: string
  response_id: string
  message: string
  data: T
}

export interface PfsenseResult<T = unknown> {
  status: number
  ok: boolean
  envelope: PfsenseEnvelope<T> | null
  raw: string
  transportError: string | null
}

function parseJson<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** A short, human-readable message for a non-2xx REST API package response. */
export function pfsenseErrorMessage(res: PfsenseResult): string {
  if (res.transportError) return res.transportError
  const env = res.envelope
  if (env?.message) return env.response_id ? `${env.message} (${env.response_id})` : env.message
  const trimmed = (res.raw ?? '').replace(/\s+/g, ' ').trim()
  if (trimmed) return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
  return `HTTP ${res.status}`
}

// --- Transport -------------------------------------------------------------

/**
 * One HTTPS request against the REST API package. Uses node:https directly
 * (not fetch) so `rejectUnauthorized` can be toggled per the `verify_tls`
 * setting — the platform's global fetch stack always verifies, which would
 * reject pfSense's default self-signed certificate.
 */
function rawRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<PfsenseResult> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const agent = new Agent({ rejectUnauthorized: init.verifyTls === true, keepAlive: false })
  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || DEFAULT_PORT,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status, ok: status >= 200 && status < 300, envelope: parseJson(raw), raw, transportError: null })
        })
      },
    )
    req.on('error', (err) => resolve({ status: 0, ok: false, envelope: null, raw: '', transportError: err.message }))
    req.on('timeout', () => {
      const reason = `Timed out after ${timeoutMs / 1000}s connecting to ${u.host}`
      req.destroy(new Error(reason))
      resolve({ status: 0, ok: false, envelope: null, raw: '', transportError: reason })
    })
    if (init.body) req.write(init.body)
    req.end()
  })
}

// --- Client ------------------------------------------------------------------

/** One firewall alias — verified against RESTAPI/Models/FirewallAlias.inc. */
export interface FirewallAlias {
  /** Array index within pfSense's aliases/alias config — read-only, server-assigned. */
  id?: number | string
  /** Immutable after creation (StringField editable:false) — never PATCHed. */
  name: string
  type: 'host' | 'network' | 'port'
  descr?: string
  address?: string[]
  detail?: string[]
}

export interface PfsenseApplyStatus {
  applied: boolean
  pending_subsystems: string[]
}

export interface PfsenseClient {
  /** Mint a JWT if this client is in JWT mode; a no-op for API-key mode. Idempotent. */
  authenticate(): Promise<{ error: string | null }>
  /** GET /api/v2/system/version — cheap reachability + auth probe. */
  getSystemVersion(): Promise<PfsenseResult>
  /** GET /api/v2/firewall/aliases — every alias, full representation (no pagination cap applied). */
  listAliases(): Promise<FirewallAlias[]>
  /** POST /api/v2/firewall/alias. Does NOT apply — call applyChanges() once after a batch. */
  createAlias(body: Omit<FirewallAlias, 'id'>): Promise<FirewallAlias>
  /** PATCH /api/v2/firewall/alias. `name` must be omitted — it cannot change. */
  updateAlias(id: number | string, body: Omit<FirewallAlias, 'id' | 'name'>): Promise<void>
  /** DELETE /api/v2/firewall/alias. */
  deleteAlias(id: number | string): Promise<void>
  /** GET /api/v2/firewall/apply — pending-change status, read-only. */
  getApplyStatus(): Promise<PfsenseApplyStatus>
  /** POST /api/v2/firewall/apply — apply ALL pending firewall changes (aliases/nat/filter/shaper). */
  applyChanges(): Promise<void>
}

/** Build a client bound to one pfSense connection (host/port/base path + credential). */
export function buildPfsenseClient(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  credential: CredentialRef | null,
  settings: PfsenseSettings,
  provider?: ProviderLike,
): { client: PfsenseClient; host: string } | { error: string } {
  const resolvedCred = resolvePfsenseCredential(credential)
  if (!resolvedCred) return { error: MISSING_CREDENTIAL_MESSAGE }
  // Re-bound with an explicit non-nullable DECLARED type (not just a narrowed
  // one) — TS does not carry a narrowing across into a closure defined later
  // in this function, only a declared type, so the nested helpers below would
  // otherwise see `PfsenseCredential | null` again.
  const cred: PfsenseCredential = resolvedCred

  const host = (resolveHost(component, connectivity, provider) ?? '').trim()
  if (!host) return { error: MISSING_HOST_MESSAGE }

  const base = buildPfsenseUrl(component, connectivity, settings, provider)
  let jwt: string | null = null

  async function authHeaders(): Promise<Record<string, string>> {
    if (cred.kind === 'api_key') return { 'X-API-Key': cred.apiKey }
    if (!jwt) {
      const auth = { error: 'JWT not yet minted — call authenticate() first' }
      throw new Error(auth.error)
    }
    return { Authorization: `Bearer ${jwt}` }
  }

  async function call<T = unknown>(method: string, path: string, body?: Record<string, unknown>): Promise<PfsenseResult<T>> {
    const headers = await authHeaders()
    return rawRequest(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      verifyTls: settings.verifyTls,
      timeoutMs: settings.timeoutMs,
    }) as Promise<PfsenseResult<T>>
  }

  const client: PfsenseClient = {
    async authenticate() {
      if (cred.kind === 'api_key') return { error: null }
      if (jwt) return { error: null }
      const basic = Buffer.from(`${cred.username}:${cred.password}`, 'utf8').toString('base64')
      const res = await rawRequest(`${base}/auth/jwt`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}` },
        verifyTls: settings.verifyTls,
        timeoutMs: settings.timeoutMs,
      })
      if (!res.ok) return { error: `pfSense JWT login failed: ${pfsenseErrorMessage(res)}` }
      const token = (res.envelope?.data as { token?: string } | undefined)?.token
      if (!token) return { error: 'pfSense JWT login succeeded but no token was returned' }
      jwt = token
      return { error: null }
    },

    async getSystemVersion() {
      return call('GET', '/system/version')
    },

    async listAliases() {
      const res = await call<FirewallAlias[]>('GET', '/firewall/aliases?limit=0')
      if (!res.ok) throw new Error(`GET /firewall/aliases -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return Array.isArray(res.envelope?.data) ? (res.envelope!.data as FirewallAlias[]) : []
    },

    async createAlias(body) {
      const res = await call<FirewallAlias>('POST', '/firewall/alias', body as unknown as Record<string, unknown>)
      if (!res.ok) throw new Error(`POST /firewall/alias "${body.name}" -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      const created = res.envelope?.data
      if (!created || created.id === undefined) {
        throw new Error(`Created alias "${body.name}" but the REST API package did not return its id`)
      }
      return created
    },

    async updateAlias(id, body) {
      const res = await call('PATCH', '/firewall/alias', { id, ...body })
      if (!res.ok) throw new Error(`PATCH /firewall/alias (id=${id}) -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },

    async deleteAlias(id) {
      const res = await call('DELETE', '/firewall/alias', { id })
      if (!res.ok && res.status !== 404) {
        throw new Error(`DELETE /firewall/alias (id=${id}) -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      }
    },

    async getApplyStatus() {
      const res = await call<PfsenseApplyStatus>('GET', '/firewall/apply')
      if (!res.ok) throw new Error(`GET /firewall/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data as PfsenseApplyStatus | undefined) ?? { applied: true, pending_subsystems: [] }
    },

    async applyChanges() {
      const res = await call('POST', '/firewall/apply')
      if (!res.ok) throw new Error(`POST /firewall/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },
  }

  return { client, host }
}
