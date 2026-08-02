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
//
// v0.2.0 adds three more resources sharing this same client, each verified
// the same way (PHP source, not prose):
//   - firewall-rules   /api/v2/firewall/rule(s)              — RESTAPI/Models/FirewallRule.inc
//   - nat-port-forwards /api/v2/firewall/nat/port_forward(s)  — RESTAPI/Models/PortForward.inc
//   - virtual-ips      /api/v2/firewall/virtual_ip(s)         — RESTAPI/Models/VirtualIP.inc
//
// ORDERING (rules and NAT port forwards are evaluated top-to-bottom):
// verified against RESTAPI/Core/Model.inc's generic `set_placement()` — ANY
// `many`-enabled Model with a `config_path` (aliases, rules, port forwards,
// virtual IPs alike) accepts an optional `placement` field (a 0-based index)
// in its create/update request body (RESTAPI/Core/Endpoint.inc reads
// `$request_data['placement']` on POST and PATCH). Setting it removes the
// object from its current array index and re-inserts it at `placement`,
// shifting everything after it down by one — same mechanic pfSense's own GUI
// drag-and-drop reordering uses. There is NO separate "move" endpoint or
// "insert after id X" convenience — it is a raw array-splice by absolute
// index, and for FirewallRule/PortForward that index is GLOBAL across the
// box's ENTIRE `filter/rule` / `nat/rule` array (not scoped to one
// interface). This app exposes it as an OPTIONAL `position` canvas field,
// passed straight through as `placement` — left blank, a new rule/port
// forward is simply appended at the end and an existing one is left exactly
// where it already is (no silent reordering). It deliberately does NOT try
// to auto-derive placement from canvas item order: doing so naively would
// assign absolute positions 0,1,2... and could shuffle rules this app does
// not own that already occupy those slots, and doing it safely (relative to
// other DECLARED rules only, accounting for unmanaged rules interleaved by
// someone else between deploys) is a harder problem this v0.2.0 does not
// attempt — FLAGGED as a known limitation, not silently glossed over.
//
// The `tracker` field on FirewallRule is UNRELATED to ordering — it is a
// read-only, auto-generated unix-time-based tracking id (used to associate a
// NAT port forward with its paired filter rule), not a position value.
//
// FLAG — FirewallRule never calls pfSense's own `mark_subsystem_dirty('filter')`
// (verified: no `$this->subsystem` assignment anywhere in FirewallRule.inc,
// unlike PortForward.inc which sets `subsystem = 'natconf'`). This means
// `GET /api/v2/firewall/apply`'s `pending_subsystems` list may under-report
// pending rule changes. It does not affect correctness here: this app always
// calls `POST /api/v2/firewall/apply` unconditionally after any write rather
// than relying on that status, and `FirewallApplyDispatcher::_process()`
// (verified) calls `filter_configure()`/`filter_configure_sync()`
// UNCONDITIONALLY — it reloads the live ruleset from config regardless of any
// dirty flag.
//
// FLAG — Virtual IPs are NOT part of the shared apply endpoint's subsystem
// list (`FirewallApply::FIREWALL_SUBSYSTEMS = ['aliases','natconf','filter',
// 'shaper']` — no `'vip'`). They have their OWN, separate apply endpoint,
// `/api/v2/firewall/virtual_ip/apply` (verified: RESTAPI/Models/VirtualIP.inc
// calls `VirtualIPApplyDispatcher`, not `FirewallApplyDispatcher`) — calling
// the general `/api/v2/firewall/apply` does NOT apply pending virtual IP
// changes. This client calls the correct one for each resource.
//
// Identity for reconciliation differs per resource by necessity, not
// preference — see each config type's `_shared.ts` module doc:
//   - firewall-aliases:   `name` (StringField unique:true) — natural key.
//   - virtual-ips:        `subnet` (StringField unique:true) — natural key.
//   - firewall-rules,
//     nat-port-forwards:  NEITHER Model declares any unique/name-like field
//     (FirewallRule.inc / PortForward.inc verified — `descr` is free-text,
//     not unique). This app therefore tracks identity via the CANVAS ITEM's
//     own stable id, recorded in rollbackData across deploys — the pattern
//     the SDK's own `DeploymentSummary.rollbackData` doc describes ("the
//     external ids it assigned per canvas item — so the next deploy can
//     match existing objects by stable id ... instead of by name").
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

/** VirtualIPApply's response shape has no `pending_subsystems` (verified: RESTAPI/Models/VirtualIPApply.inc declares only `applied`). */
export interface PfsenseVipApplyStatus {
  applied: boolean
}

/**
 * One firewall rule — a deliberately-scoped SUBSET of FirewallRule.inc's ~30
 * fields (verified against the full Model source). Covers the core
 * match/action fields every rule needs; DROPS the advanced traffic-shaping
 * and scheduling knobs (dscp, tag, tcp_flags_*, gateway, sched, dnpipe,
 * pdnpipe, defaultqueue, ackqueue, icmptype) as out of scope for v0.2.0 —
 * flagged rather than half-implemented. `tracker`/`created_*`/`updated_*`/
 * `associated_rule_id` are server-managed and never written.
 */
export interface FirewallRule {
  id?: number | string
  type: 'pass' | 'block' | 'reject'
  /** `many:true` on the API side but capped to ONE entry unless `floating` is true (verified: validate_interface()). */
  interface: string[]
  ipprotocol: 'inet' | 'inet6' | 'inet46'
  /** `null` (or omitted) means "any protocol" — matches the API's own `allow_null` default. */
  protocol?: string | null
  source: string
  source_port?: string | null
  destination: string
  destination_port?: string | null
  descr?: string
  disabled?: boolean
  log?: boolean
  /** Immutable after creation (StringField editable:false) — never PATCHed, see updateFirewallRule. */
  floating?: boolean
  /** Only meaningful when `floating` is true. */
  quick?: boolean
  /** Only meaningful when `floating` is true. */
  direction?: 'any' | 'in' | 'out'
  statetype?: 'keep state' | 'sloppy state' | 'synproxy state' | 'none'
}

/**
 * One NAT port forward — verified against RESTAPI/Models/PortForward.inc.
 * `associated_rule_id` controls whether/how a paired "pass" firewall rule is
 * auto-managed by pfSense itself: `''` (default) requires a separate rule,
 * `'new'` auto-creates one, `'pass'` passes matching traffic with no rule at
 * all, or an existing rule's `associated_rule_id` links to it directly.
 */
export interface PortForward {
  id?: number | string
  interface: string
  ipprotocol?: 'inet' | 'inet6' | 'inet46'
  protocol: string
  source: string
  source_port?: string | null
  destination: string
  destination_port?: string | null
  target: string
  local_port: string
  disabled?: boolean
  nordr?: boolean
  nosync?: boolean
  descr?: string
  natreflection?: 'enable' | 'disable' | 'purenat' | null
  associated_rule_id?: string
}

/**
 * One virtual IP — verified against RESTAPI/Models/VirtualIP.inc. `password`
 * is CARP-only and sensitive (the shared VHID group secret); `carp_mode`/
 * `carp_peer` are Plus-only per the package's own help text (harmless no-ops
 * on CE). `carp_status`/`uniqid` are read-only/system-generated and never written.
 */
export interface VirtualIP {
  id?: number | string
  mode: 'ipalias' | 'proxyarp' | 'carp' | 'other'
  interface: string
  type?: 'single' | 'network'
  subnet: string
  subnet_bits: number
  descr?: string
  noexpand?: boolean
  vhid?: number
  advbase?: number
  advskew?: number
  password?: string
  carp_mode?: 'mcast' | 'ucast'
  carp_peer?: string
}

/** A generic CRUD surface for one `many`-enabled REST API package resource, shared by every resource this client exposes. */
interface PfsenseCrudOps<T> {
  list(): Promise<T[]>
  create(body: Record<string, unknown>, opts?: { placement?: number }): Promise<T>
  update(id: number | string, body: Record<string, unknown>, opts?: { placement?: number }): Promise<void>
  remove(id: number | string): Promise<void>
}

type CallFn = <T = unknown>(method: string, path: string, body?: Record<string, unknown>) => Promise<PfsenseResult<T>>

/**
 * Build a CRUD surface for one resource's singular (`GET/POST/PATCH/DELETE`)
 * and plural (`GET`, listing) endpoints. Every resource in this package
 * follows the identical create/update/delete/list + envelope conventions
 * (verified across FirewallAlias, FirewallRule, PortForward and VirtualIP's
 * Endpoint classes) — only the URL segments and each resource's own field
 * set differ, so this is the ONE implementation every resource-specific
 * method below delegates to (DRY, mirrors this codebase's Cisco ISE ERS
 * client's `buildErsResourceClient`).
 */
function buildCrudOps<T extends { id?: number | string }>(call: CallFn, singularPath: string, pluralPath: string, resourceLabel: string): PfsenseCrudOps<T> {
  return {
    async list() {
      const res = await call<T[]>('GET', `${pluralPath}?limit=0`)
      if (!res.ok) throw new Error(`GET ${pluralPath} -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return Array.isArray(res.envelope?.data) ? (res.envelope!.data as T[]) : []
    },
    async create(body, opts) {
      const payload = opts?.placement !== undefined ? { ...body, placement: opts.placement } : body
      const res = await call<T>('POST', singularPath, payload)
      if (!res.ok) throw new Error(`POST ${singularPath} -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      const created = res.envelope?.data
      if (!created || created.id === undefined) {
        throw new Error(`Created a ${resourceLabel} but the REST API package did not return its id`)
      }
      return created
    },
    async update(id, body, opts) {
      const payload = opts?.placement !== undefined ? { id, ...body, placement: opts.placement } : { id, ...body }
      const res = await call('PATCH', singularPath, payload)
      if (!res.ok) throw new Error(`PATCH ${singularPath} (id=${id}) -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },
    async remove(id) {
      const res = await call('DELETE', singularPath, { id })
      if (!res.ok && res.status !== 404) {
        throw new Error(`DELETE ${singularPath} (id=${id}) -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      }
    },
  }
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

  /** GET /api/v2/firewall/rules — every rule, full representation. */
  listFirewallRules(): Promise<FirewallRule[]>
  /** POST /api/v2/firewall/rule. `opts.placement` — see this file's module doc on ordering. Does NOT apply. */
  createFirewallRule(body: Omit<FirewallRule, 'id'>, opts?: { placement?: number }): Promise<FirewallRule>
  /** PATCH /api/v2/firewall/rule. `floating` must be omitted — it cannot change. */
  updateFirewallRule(id: number | string, body: Omit<FirewallRule, 'id' | 'floating'>, opts?: { placement?: number }): Promise<void>
  /** DELETE /api/v2/firewall/rule. */
  deleteFirewallRule(id: number | string): Promise<void>

  /** GET /api/v2/firewall/nat/port_forwards — every port forward, full representation. */
  listPortForwards(): Promise<PortForward[]>
  /** POST /api/v2/firewall/nat/port_forward. `opts.placement` — see this file's module doc on ordering. Does NOT apply. */
  createPortForward(body: Omit<PortForward, 'id'>, opts?: { placement?: number }): Promise<PortForward>
  /** PATCH /api/v2/firewall/nat/port_forward. */
  updatePortForward(id: number | string, body: Omit<PortForward, 'id'>, opts?: { placement?: number }): Promise<void>
  /** DELETE /api/v2/firewall/nat/port_forward. */
  deletePortForward(id: number | string): Promise<void>

  /** GET /api/v2/firewall/virtual_ips — every virtual IP, full representation. */
  listVirtualIps(): Promise<VirtualIP[]>
  /** POST /api/v2/firewall/virtual_ip. Does NOT apply — call applyVirtualIpChanges() once after a batch. */
  createVirtualIp(body: Omit<VirtualIP, 'id'>): Promise<VirtualIP>
  /** PATCH /api/v2/firewall/virtual_ip. */
  updateVirtualIp(id: number | string, body: Omit<VirtualIP, 'id'>): Promise<void>
  /** DELETE /api/v2/firewall/virtual_ip. */
  deleteVirtualIp(id: number | string): Promise<void>
  /** GET /api/v2/firewall/virtual_ip/apply — pending virtual-IP status. SEPARATE from getApplyStatus(). */
  getVirtualIpApplyStatus(): Promise<PfsenseVipApplyStatus>
  /** POST /api/v2/firewall/virtual_ip/apply — apply pending virtual-IP changes. SEPARATE from applyChanges(). */
  applyVirtualIpChanges(): Promise<void>
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

  const aliasOps = buildCrudOps<FirewallAlias>(call, '/firewall/alias', '/firewall/aliases', 'alias')
  const ruleOps = buildCrudOps<FirewallRule>(call, '/firewall/rule', '/firewall/rules', 'firewall rule')
  const portForwardOps = buildCrudOps<PortForward>(call, '/firewall/nat/port_forward', '/firewall/nat/port_forwards', 'NAT port forward')
  const virtualIpOps = buildCrudOps<VirtualIP>(call, '/firewall/virtual_ip', '/firewall/virtual_ips', 'virtual IP')

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

    listAliases: () => aliasOps.list(),
    createAlias: (body) => aliasOps.create(body),
    updateAlias: (id, body) => aliasOps.update(id, body),
    deleteAlias: (id) => aliasOps.remove(id),

    async getApplyStatus() {
      const res = await call<PfsenseApplyStatus>('GET', '/firewall/apply')
      if (!res.ok) throw new Error(`GET /firewall/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data as PfsenseApplyStatus | undefined) ?? { applied: true, pending_subsystems: [] }
    },

    async applyChanges() {
      const res = await call('POST', '/firewall/apply')
      if (!res.ok) throw new Error(`POST /firewall/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },

    listFirewallRules: () => ruleOps.list(),
    createFirewallRule: (body, opts) => ruleOps.create(body, opts),
    updateFirewallRule: (id, body, opts) => ruleOps.update(id, body, opts),
    deleteFirewallRule: (id) => ruleOps.remove(id),

    listPortForwards: () => portForwardOps.list(),
    createPortForward: (body, opts) => portForwardOps.create(body, opts),
    updatePortForward: (id, body, opts) => portForwardOps.update(id, body, opts),
    deletePortForward: (id) => portForwardOps.remove(id),

    listVirtualIps: () => virtualIpOps.list(),
    createVirtualIp: (body) => virtualIpOps.create(body),
    updateVirtualIp: (id, body) => virtualIpOps.update(id, body),
    deleteVirtualIp: (id) => virtualIpOps.remove(id),

    async getVirtualIpApplyStatus() {
      const res = await call<PfsenseVipApplyStatus>('GET', '/firewall/virtual_ip/apply')
      if (!res.ok) throw new Error(`GET /firewall/virtual_ip/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data as PfsenseVipApplyStatus | undefined) ?? { applied: true }
    },

    async applyVirtualIpChanges() {
      const res = await call('POST', '/firewall/virtual_ip/apply')
      if (!res.ok) throw new Error(`POST /firewall/virtual_ip/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },
  }

  return { client, host }
}
