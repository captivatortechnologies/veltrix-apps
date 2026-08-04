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
//
// v0.3.0 EXHAUSTS the package's remaining meaningful declarative surface —
// see README.md's Coverage section for the full managed-vs-excluded list.
// New resources and their apply/identity model (all verified against PHP
// source, same discipline as above):
//   - nat-outbound-mode:      /api/v2/firewall/nat/outbound/mode (PATCH-only
//     singleton, RESTAPI/Models/OutboundNATMode.inc). NOTE: the Model's own
//     help text says "manual" but its actual `choices` array is
//     `['automatic','hybrid','advanced','disabled']` — a real mismatch in
//     the package's own docstring; this client uses the verified `choices`
//     values, not the prose.
//   - nat-outbound-mappings:  /api/v2/firewall/nat/outbound/mapping(s)
//     (RESTAPI/Models/OutboundNATMapping.inc, subsystem 'natconf' — shares
//     the main /api/v2/firewall/apply). No unique field -> itemId-tracked,
//     same as firewall-rules. Split into its own config type from the mode
//     setting above because a canvas item schema is homogeneous per config
//     type — a singleton "mode" selector and a repeatable mapping list
//     can't share one canvas.
//   - nat-one-to-one:         /api/v2/firewall/nat/one_to_one/mapping(s)
//     (RESTAPI/Models/OneToOneNATMapping.inc, subsystem 'natconf' — shares
//     /api/v2/firewall/apply). No unique field -> itemId-tracked.
//   - firewall-schedules:     /api/v2/firewall/schedule(s)
//     (RESTAPI/Models/FirewallSchedule.inc, `name` unique+required -> name-
//     keyed like aliases; `always_apply: true` but STILL reloads the filter
//     via FirewallApplyDispatcher, so this app still calls the shared
//     /api/v2/firewall/apply once per deploy for consistency/certainty).
//     Requires >=1 embedded time range (NestedModelField over
//     RESTAPI/Models/FirewallScheduleTimeRange.inc) — v0.3.0 supports
//     exactly ONE time range per schedule (the common case); multiple time
//     ranges per schedule (e.g. different hours on different days) is
//     FLAGGED as out of scope, not faked.
//   - gateways:               /api/v2/routing/gateway(s)
//     (RESTAPI/Models/RoutingGateway.inc, `name` unique+immutable -> name-
//     keyed). Applies via /api/v2/routing/apply (RoutingApplyDispatcher) —
//     a THIRD distinct apply endpoint, separate from both
//     /api/v2/firewall/apply and /api/v2/firewall/virtual_ip/apply.
//   - static-routes:          /api/v2/routing/static_route(s)
//     (RESTAPI/Models/StaticRoute.inc, no unique field -> itemId-tracked).
//     ALSO applies via /api/v2/routing/apply (same RoutingApplyDispatcher
//     as gateways — confirmed both share this endpoint).
//   - dns-resolver-host-overrides: /api/v2/services/dns_resolver/host_override(s)
//     (RESTAPI/Models/DNSResolverHostOverride.inc, `unique_together_fields
//     = ['host','domain']` — a COMPOSITE key, not a single field -> this app
//     uses `${host}.${domain}` as its identity key). Applies via
//     /api/v2/services/dns_resolver/apply — a FOURTH distinct apply
//     endpoint. The Model's nested `aliases` (additional alias hostnames
//     per override) is FLAGGED as out of scope for v0.3.0 (another
//     NestedModelField, same complexity/scope call as firewall-schedules'
//     time ranges) — every override is created with zero aliases.
//   - dns-resolver-domain-overrides: /api/v2/services/dns_resolver/domain_override(s)
//     (RESTAPI/Models/DNSResolverDomainOverride.inc, `domain` used as this
//     app's identity key — not formally `unique:true` in the Model, but
//     pfSense's own GUI treats one override per domain as the norm). Shares
//     the same DNS resolver apply endpoint.
//   - users:                  /api/v2/user (RESTAPI/Models/User.inc, `name`
//     unique -> name-keyed). `always_apply: true` — every write applies
//     itself immediately (`local_user_set`/`local_user_del`); there is NO
//     apply endpoint to call afterward. `password` is treated write-only in
//     spirit (never diffed by drift, never restored by rollback) even
//     though the Model does not mark it `write_only` — GET responses return
//     the stored HASH (bcrypt/etc, keyed by the system's configured
//     `pwhash` algorithm), never plaintext, but this app does not treat a
//     hash as meaningfully comparable/restorable either.
//   - user-groups:            /api/v2/user/group (RESTAPI/Models/UserGroup.inc,
//     `name` unique -> name-keyed). Also `always_apply: true` — no apply
//     endpoint.
//
// EXCLUDED, deliberately (see README.md's Coverage section for the full
// list and every other surface's reasoning): Certificates and Certificate
// Authorities (RESTAPI/Models/Certificate.inc / CertificateAuthority.inc)
// — importing one requires transmitting the PRIVATE KEY (`prv`, required,
// `sensitive: true`) through canvas config, which this app treats as real
// key material exactly like VPN tunnels, never something to author as
// declarative config; and `CertificateGenerate` (POST-only, `always_apply:
// true`, no meaningful PATCH/update semantics) doesn't fit this app's
// create/update/drift/rollback reconciliation model even though the
// generated private key stays server-side.
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

/**
 * The simpler `{ applied }`-only apply-status shape (no `pending_subsystems`)
 * — verified shared by VirtualIPApply.inc, RoutingApply.inc and
 * DNSResolverApply.inc, each declaring only a single `applied` BooleanField.
 */
export interface PfsenseSimpleApplyStatus {
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

/** Verified against RESTAPI/Models/OutboundNATMode.inc — the `choices` array, not its (mismatched) prose help text. */
export type OutboundNatMode = 'automatic' | 'hybrid' | 'advanced' | 'disabled'

/**
 * One outbound NAT mapping — a deliberately-scoped SUBSET of
 * OutboundNATMapping.inc's 16 fields. Covers the core match/target fields;
 * DROPS the advanced load-balancing knobs (`poolopts`, `source_hash_key`)
 * and `nosync` (HA-sync cosmetic) as out of scope for v0.3.0.
 */
export interface OutboundNatMapping {
  id?: number | string
  interface: string
  protocol?: string | null
  disabled?: boolean
  nonat?: boolean
  source: string
  source_port?: string | null
  destination: string
  destination_port?: string | null
  /** Required unless `nonat` is true. */
  target?: string
  /** 1-128; only applicable when `target` is an IP or alias. */
  target_subnet?: number
  static_nat_port?: boolean
  nat_port?: string
  descr?: string
}

/** One 1:1 NAT mapping — verified against RESTAPI/Models/OneToOneNATMapping.inc (full field set; compact model, no scope cuts needed). */
export interface OneToOneNatMapping {
  id?: number | string
  interface: string
  disabled?: boolean
  nobinat?: boolean
  natreflection?: 'enable' | 'disable' | null
  ipprotocol?: 'inet' | 'inet6'
  external: string
  source: string
  destination: string
  descr?: string
}

/**
 * One time range embedded in a firewall schedule — verified against
 * RESTAPI/Models/FirewallScheduleTimeRange.inc. `position` (days of week,
 * 1-7) and `month`+`day` (specific dates) are MUTUALLY EXCLUSIVE — the API
 * only reads `month`/`day` when `position` is unset (`conditions: ['position'
 * => null]`). `hour` is a "HH:MM-HH:MM" 24-hour range whose minutes must be
 * one of 00/15/30/45/59 (verified — an unusual, asymmetric set, not every
 * 15 minutes).
 */
export interface FirewallScheduleTimeRange {
  position?: number[] | null
  month?: number[]
  day?: number[]
  hour: string
  rangedescr?: string
}

/**
 * One firewall schedule — verified against RESTAPI/Models/FirewallSchedule.inc.
 * `name` is required+unique (name-keyed identity, like aliases). Exactly one
 * embedded `timerange` entry is supported in v0.3.0 — see this file's
 * module doc.
 */
export interface FirewallSchedule {
  id?: number | string
  name: string
  descr?: string
  timerange: FirewallScheduleTimeRange[]
}

/**
 * One routing gateway — a deliberately-scoped SUBSET of RoutingGateway.inc's
 * ~23 fields (verified). Covers identity/match + the two most commonly
 * hand-tuned monitoring toggles (`monitor_disable`/`monitor`, `weight`);
 * DROPS the advanced dpinger tuning knobs (action_disable, force_down,
 * dpinger_dont_add_static_route, gw_down_kill_states, nonlocalgateway,
 * data_payload, latencylow/high, losslow/high, interval, loss_interval,
 * time_period, alert_interval) as out of scope for v0.3.0 — every dropped
 * field has a server-side default (verified), so omitting them is safe, not
 * silently wrong. `name` is immutable after creation (`editable: false`).
 */
export interface RoutingGateway {
  id?: number | string
  name: string
  descr?: string
  disabled?: boolean
  ipprotocol: 'inet' | 'inet6'
  interface: string
  /** An IPv4/IPv6 address, or the literal "dynamic" for a dynamic (e.g. PPPoE) interface. */
  gateway: string
  monitor_disable?: boolean
  monitor?: string | null
  weight?: number
}

/** One static route — verified against RESTAPI/Models/StaticRoute.inc (compact model, no scope cuts needed). No unique field -> itemId-tracked. */
export interface StaticRoute {
  id?: number | string
  /** A CIDR subnet, or an existing host/network alias name. */
  network: string
  /** An existing RoutingGateway or RoutingGatewayGroup name. */
  gateway: string
  descr?: string
  disabled?: boolean
}

/** One additional alias hostname on a DNS Resolver host override — verified against RESTAPI/Models/DNSResolverHostOverrideAlias.inc. NOT supported for creation in v0.3.0 — see this file's module doc; kept here only for the type's completeness. */
export interface DnsResolverHostOverrideAlias {
  host: string
  domain: string
  descr?: string
}

/**
 * One DNS Resolver host override — verified against
 * RESTAPI/Models/DNSResolverHostOverride.inc. `host`+`domain` together are
 * `unique_together_fields` (a COMPOSITE key) -> this app's identity is
 * `${host}.${domain}`. The nested `aliases` list is NOT populated by this
 * app in v0.3.0 (flagged, see module doc) — every override this app writes
 * has zero aliases.
 */
export interface DnsResolverHostOverride {
  id?: number | string
  /** May be an empty string to override the bare domain itself (verified: `allow_empty: true`). */
  host: string
  domain: string
  ip: string[]
  descr?: string
  aliases?: DnsResolverHostOverrideAlias[]
}

/** One DNS Resolver domain override — verified against RESTAPI/Models/DNSResolverDomainOverride.inc (compact model, no scope cuts needed). */
export interface DnsResolverDomainOverride {
  id?: number | string
  domain: string
  ip: string
  descr?: string
  forward_tls_upstream?: boolean
  tls_hostname?: string
}

/**
 * One local pfSense user — a deliberately-scoped SUBSET of User.inc's 11
 * fields (verified). `uid`/`scope` are server-managed and never written.
 * `cert` (linking existing certificate `refid`s) is DROPPED for v0.3.0 —
 * this app does not manage Certificates at all (see module doc), so there
 * is nothing valid to link. `password` is treated write-only in spirit
 * (never diffed/restored) even though the Model itself does not mark it
 * `write_only` — see module doc. `expires` uses pfSense's own `m/d/Y`
 * (MM/DD/YYYY) format, verified.
 */
export interface PfsenseUser {
  id?: number | string
  name: string
  password?: string
  disabled?: boolean
  descr?: string
  /** Raw pfSense privilege constant names (e.g. "page-all") — validated server-side only, see module doc. */
  priv?: string[]
  /** "m/d/Y" format (e.g. "12/31/2026"), or empty string for no expiration. */
  expires?: string
  /** Base64-encoded SSH authorized_keys content. */
  authorizedkeys?: string
  ipsecpsk?: string
  /** Read-only, server-managed (default "user"; system accounts like "admin" carry a different value) — never written; read to skip touching system accounts. */
  scope?: string
}

/** One local pfSense user group — verified against RESTAPI/Models/UserGroup.inc. `gid`/`scope` are server-managed; `scope: "system"` groups cannot be created/deleted by this app (verified — the Model itself forbids it). */
export interface PfsenseUserGroup {
  id?: number | string
  name: string
  description?: string
  /** Existing local user names to add as members. */
  member?: string[]
  /** Raw pfSense privilege constant names — validated server-side only. */
  priv?: string[]
  /** Read-only, server-managed ("local" | "remote" | "system") — never written; read to skip touching system-scoped groups. */
  scope?: string
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
  getVirtualIpApplyStatus(): Promise<PfsenseSimpleApplyStatus>
  /** POST /api/v2/firewall/virtual_ip/apply — apply pending virtual-IP changes. SEPARATE from applyChanges(). */
  applyVirtualIpChanges(): Promise<void>

  /** GET /api/v2/firewall/nat/outbound/mode — the current outbound NAT mode. */
  getOutboundNatMode(): Promise<OutboundNatMode>
  /** PATCH /api/v2/firewall/nat/outbound/mode. Does NOT apply — call applyChanges() afterward. */
  updateOutboundNatMode(mode: OutboundNatMode): Promise<void>

  /** GET /api/v2/firewall/nat/outbound/mappings — every outbound NAT mapping, full representation. */
  listOutboundNatMappings(): Promise<OutboundNatMapping[]>
  /** POST /api/v2/firewall/nat/outbound/mapping. `opts.placement` — see this file's module doc on ordering. Does NOT apply. */
  createOutboundNatMapping(body: Omit<OutboundNatMapping, 'id'>, opts?: { placement?: number }): Promise<OutboundNatMapping>
  /** PATCH /api/v2/firewall/nat/outbound/mapping. */
  updateOutboundNatMapping(id: number | string, body: Omit<OutboundNatMapping, 'id'>, opts?: { placement?: number }): Promise<void>
  /** DELETE /api/v2/firewall/nat/outbound/mapping. */
  deleteOutboundNatMapping(id: number | string): Promise<void>

  /** GET /api/v2/firewall/nat/one_to_one/mappings — every 1:1 NAT mapping, full representation. */
  listOneToOneNatMappings(): Promise<OneToOneNatMapping[]>
  /** POST /api/v2/firewall/nat/one_to_one/mapping. Does NOT apply. */
  createOneToOneNatMapping(body: Omit<OneToOneNatMapping, 'id'>): Promise<OneToOneNatMapping>
  /** PATCH /api/v2/firewall/nat/one_to_one/mapping. */
  updateOneToOneNatMapping(id: number | string, body: Omit<OneToOneNatMapping, 'id'>): Promise<void>
  /** DELETE /api/v2/firewall/nat/one_to_one/mapping. */
  deleteOneToOneNatMapping(id: number | string): Promise<void>

  /** GET /api/v2/firewall/schedules — every schedule, full representation. */
  listFirewallSchedules(): Promise<FirewallSchedule[]>
  /** POST /api/v2/firewall/schedule. Does NOT apply. */
  createFirewallSchedule(body: Omit<FirewallSchedule, 'id'>): Promise<FirewallSchedule>
  /** PATCH /api/v2/firewall/schedule. */
  updateFirewallSchedule(id: number | string, body: Omit<FirewallSchedule, 'id'>): Promise<void>
  /** DELETE /api/v2/firewall/schedule. */
  deleteFirewallSchedule(id: number | string): Promise<void>

  /** GET /api/v2/routing/gateways — every gateway, full representation. */
  listRoutingGateways(): Promise<RoutingGateway[]>
  /** POST /api/v2/routing/gateway. Does NOT apply — call applyRoutingChanges() once after a batch. */
  createRoutingGateway(body: Omit<RoutingGateway, 'id'>): Promise<RoutingGateway>
  /** PATCH /api/v2/routing/gateway. `name` must be omitted — it cannot change. */
  updateRoutingGateway(id: number | string, body: Omit<RoutingGateway, 'id' | 'name'>): Promise<void>
  /** DELETE /api/v2/routing/gateway. */
  deleteRoutingGateway(id: number | string): Promise<void>

  /** GET /api/v2/routing/static_routes — every static route, full representation. */
  listStaticRoutes(): Promise<StaticRoute[]>
  /** POST /api/v2/routing/static_route. Does NOT apply. */
  createStaticRoute(body: Omit<StaticRoute, 'id'>): Promise<StaticRoute>
  /** PATCH /api/v2/routing/static_route. */
  updateStaticRoute(id: number | string, body: Omit<StaticRoute, 'id'>): Promise<void>
  /** DELETE /api/v2/routing/static_route. */
  deleteStaticRoute(id: number | string): Promise<void>
  /** GET /api/v2/routing/apply — pending routing-change status. SEPARATE from getApplyStatus()/getVirtualIpApplyStatus(). Shared by gateways AND static routes. */
  getRoutingApplyStatus(): Promise<PfsenseSimpleApplyStatus>
  /** POST /api/v2/routing/apply — apply pending gateway/static-route changes. */
  applyRoutingChanges(): Promise<void>

  /** GET /api/v2/services/dns_resolver/host_overrides — every host override, full representation. */
  listDnsResolverHostOverrides(): Promise<DnsResolverHostOverride[]>
  /** POST /api/v2/services/dns_resolver/host_override. Does NOT apply. */
  createDnsResolverHostOverride(body: Omit<DnsResolverHostOverride, 'id'>): Promise<DnsResolverHostOverride>
  /** PATCH /api/v2/services/dns_resolver/host_override. */
  updateDnsResolverHostOverride(id: number | string, body: Omit<DnsResolverHostOverride, 'id'>): Promise<void>
  /** DELETE /api/v2/services/dns_resolver/host_override. */
  deleteDnsResolverHostOverride(id: number | string): Promise<void>

  /** GET /api/v2/services/dns_resolver/domain_overrides — every domain override, full representation. */
  listDnsResolverDomainOverrides(): Promise<DnsResolverDomainOverride[]>
  /** POST /api/v2/services/dns_resolver/domain_override. Does NOT apply. */
  createDnsResolverDomainOverride(body: Omit<DnsResolverDomainOverride, 'id'>): Promise<DnsResolverDomainOverride>
  /** PATCH /api/v2/services/dns_resolver/domain_override. */
  updateDnsResolverDomainOverride(id: number | string, body: Omit<DnsResolverDomainOverride, 'id'>): Promise<void>
  /** DELETE /api/v2/services/dns_resolver/domain_override. */
  deleteDnsResolverDomainOverride(id: number | string): Promise<void>
  /** GET /api/v2/services/dns_resolver/apply — pending DNS Resolver status. SEPARATE from every other apply endpoint. */
  getDnsResolverApplyStatus(): Promise<PfsenseSimpleApplyStatus>
  /** POST /api/v2/services/dns_resolver/apply — apply pending host/domain override changes. */
  applyDnsResolverChanges(): Promise<void>

  /** GET /api/v2/users — every local user, full representation. */
  listUsers(): Promise<PfsenseUser[]>
  /** POST /api/v2/user. `always_apply` server-side — no apply-endpoint call needed. */
  createUser(body: Omit<PfsenseUser, 'id'>): Promise<PfsenseUser>
  /** PATCH /api/v2/user. */
  updateUser(id: number | string, body: Omit<PfsenseUser, 'id'>): Promise<void>
  /** DELETE /api/v2/user. */
  deleteUser(id: number | string): Promise<void>

  /** GET /api/v2/user/groups — every local user group, full representation. */
  listUserGroups(): Promise<PfsenseUserGroup[]>
  /** POST /api/v2/user/group. `always_apply` server-side — no apply-endpoint call needed. */
  createUserGroup(body: Omit<PfsenseUserGroup, 'id'>): Promise<PfsenseUserGroup>
  /** PATCH /api/v2/user/group. */
  updateUserGroup(id: number | string, body: Omit<PfsenseUserGroup, 'id'>): Promise<void>
  /** DELETE /api/v2/user/group. */
  deleteUserGroup(id: number | string): Promise<void>
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
  const outboundNatMappingOps = buildCrudOps<OutboundNatMapping>(
    call,
    '/firewall/nat/outbound/mapping',
    '/firewall/nat/outbound/mappings',
    'outbound NAT mapping',
  )
  const oneToOneNatOps = buildCrudOps<OneToOneNatMapping>(call, '/firewall/nat/one_to_one/mapping', '/firewall/nat/one_to_one/mappings', '1:1 NAT mapping')
  const scheduleOps = buildCrudOps<FirewallSchedule>(call, '/firewall/schedule', '/firewall/schedules', 'firewall schedule')
  const gatewayOps = buildCrudOps<RoutingGateway>(call, '/routing/gateway', '/routing/gateways', 'routing gateway')
  const staticRouteOps = buildCrudOps<StaticRoute>(call, '/routing/static_route', '/routing/static_routes', 'static route')
  const dnsHostOverrideOps = buildCrudOps<DnsResolverHostOverride>(
    call,
    '/services/dns_resolver/host_override',
    '/services/dns_resolver/host_overrides',
    'DNS Resolver host override',
  )
  const dnsDomainOverrideOps = buildCrudOps<DnsResolverDomainOverride>(
    call,
    '/services/dns_resolver/domain_override',
    '/services/dns_resolver/domain_overrides',
    'DNS Resolver domain override',
  )
  const userOps = buildCrudOps<PfsenseUser>(call, '/user', '/users', 'user')
  const userGroupOps = buildCrudOps<PfsenseUserGroup>(call, '/user/group', '/user/groups', 'user group')

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
      const res = await call<PfsenseSimpleApplyStatus>('GET', '/firewall/virtual_ip/apply')
      if (!res.ok) throw new Error(`GET /firewall/virtual_ip/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data as PfsenseSimpleApplyStatus | undefined) ?? { applied: true }
    },

    async applyVirtualIpChanges() {
      const res = await call('POST', '/firewall/virtual_ip/apply')
      if (!res.ok) throw new Error(`POST /firewall/virtual_ip/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },

    async getOutboundNatMode() {
      const res = await call<{ mode?: OutboundNatMode }>('GET', '/firewall/nat/outbound/mode')
      if (!res.ok) throw new Error(`GET /firewall/nat/outbound/mode -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data?.mode as OutboundNatMode | undefined) ?? 'automatic'
    },
    async updateOutboundNatMode(mode) {
      const res = await call('PATCH', '/firewall/nat/outbound/mode', { mode })
      if (!res.ok) throw new Error(`PATCH /firewall/nat/outbound/mode -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },

    listOutboundNatMappings: () => outboundNatMappingOps.list(),
    createOutboundNatMapping: (body, opts) => outboundNatMappingOps.create(body, opts),
    updateOutboundNatMapping: (id, body, opts) => outboundNatMappingOps.update(id, body, opts),
    deleteOutboundNatMapping: (id) => outboundNatMappingOps.remove(id),

    listOneToOneNatMappings: () => oneToOneNatOps.list(),
    createOneToOneNatMapping: (body) => oneToOneNatOps.create(body),
    updateOneToOneNatMapping: (id, body) => oneToOneNatOps.update(id, body),
    deleteOneToOneNatMapping: (id) => oneToOneNatOps.remove(id),

    listFirewallSchedules: () => scheduleOps.list(),
    createFirewallSchedule: (body) => scheduleOps.create(body),
    updateFirewallSchedule: (id, body) => scheduleOps.update(id, body),
    deleteFirewallSchedule: (id) => scheduleOps.remove(id),

    listRoutingGateways: () => gatewayOps.list(),
    createRoutingGateway: (body) => gatewayOps.create(body),
    updateRoutingGateway: (id, body) => gatewayOps.update(id, body),
    deleteRoutingGateway: (id) => gatewayOps.remove(id),

    listStaticRoutes: () => staticRouteOps.list(),
    createStaticRoute: (body) => staticRouteOps.create(body),
    updateStaticRoute: (id, body) => staticRouteOps.update(id, body),
    deleteStaticRoute: (id) => staticRouteOps.remove(id),

    async getRoutingApplyStatus() {
      const res = await call<PfsenseSimpleApplyStatus>('GET', '/routing/apply')
      if (!res.ok) throw new Error(`GET /routing/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data as PfsenseSimpleApplyStatus | undefined) ?? { applied: true }
    },
    async applyRoutingChanges() {
      const res = await call('POST', '/routing/apply')
      if (!res.ok) throw new Error(`POST /routing/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },

    listDnsResolverHostOverrides: () => dnsHostOverrideOps.list(),
    createDnsResolverHostOverride: (body) => dnsHostOverrideOps.create(body),
    updateDnsResolverHostOverride: (id, body) => dnsHostOverrideOps.update(id, body),
    deleteDnsResolverHostOverride: (id) => dnsHostOverrideOps.remove(id),

    listDnsResolverDomainOverrides: () => dnsDomainOverrideOps.list(),
    createDnsResolverDomainOverride: (body) => dnsDomainOverrideOps.create(body),
    updateDnsResolverDomainOverride: (id, body) => dnsDomainOverrideOps.update(id, body),
    deleteDnsResolverDomainOverride: (id) => dnsDomainOverrideOps.remove(id),

    async getDnsResolverApplyStatus() {
      const res = await call<PfsenseSimpleApplyStatus>('GET', '/services/dns_resolver/apply')
      if (!res.ok) throw new Error(`GET /services/dns_resolver/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
      return (res.envelope?.data as PfsenseSimpleApplyStatus | undefined) ?? { applied: true }
    },
    async applyDnsResolverChanges() {
      const res = await call('POST', '/services/dns_resolver/apply')
      if (!res.ok) throw new Error(`POST /services/dns_resolver/apply -> HTTP ${res.status}: ${pfsenseErrorMessage(res)}`)
    },

    listUsers: () => userOps.list(),
    createUser: (body) => userOps.create(body),
    updateUser: (id, body) => userOps.update(id, body),
    deleteUser: (id) => userOps.remove(id),

    listUserGroups: () => userGroupOps.list(),
    createUserGroup: (body) => userGroupOps.create(body),
    updateUserGroup: (id, body) => userGroupOps.update(id, body),
    deleteUserGroup: (id) => userGroupOps.remove(id),
  }

  return { client, host }
}
