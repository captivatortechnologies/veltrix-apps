// =============================================================================
// Aqua Security REST API client — Aqua CSP / Enterprise Console.
//
// Surface: the Aqua CSP (Cloud-Native Application Protection Platform)
// Console REST API, reachable at the customer's own Console base URL — either
// a self-hosted Console or a single-tenant Aqua-hosted Console (the same
// product, same API, post-login). This is distinct from the multi-tenant
// Aqua SaaS flow (cloud.aquasec.com), which layers a region + tenant-resolution
// step ("ese_url") on top of the same downstream API — out of scope for
// v0.1.0 (see README "Coverage" — SaaS multi-region auth).
//
// Auth — verified against the OFFICIAL Aqua Terraform provider's own Go client
// (github.com/aquasecurity/terraform-provider-aquasec, client/client.go,
// GetCspAuthToken / NewClientWithTokenAuth):
//   POST {aqua_url}/api/v1/login   { "id": "<user>", "password": "<password>" }
//     -> 200 { "token": "<jwt>" }
//   ...every other call...   header  Authorization: Bearer <token>
// The Terraform provider's own docs recommend a dedicated Aqua user + role +
// "API Only" permission set for this credential (docs/index.md). The token is
// cached for the lifetime of this client instance; a 401 triggers exactly one
// re-login-and-retry (the token has a configurable validity window, default
// 1500 minutes server-side).
//
// A separate API-key + HMAC-signature auth mode exists (X-API-Key/X-Timestamp/
// X-Signature, POST /v2/tokens) but is SaaS-only (client.go's
// AuthenticateWithAPIKey resolves a fixed SaaS token host) — not applicable to
// a CSP/Enterprise Console, so this client does not implement it.
//
// Write endpoints this app's config types use, ALL confirmed against the same
// Terraform provider's client/*.go (the officially maintained Go SDK for this
// API — there is no public OpenAPI spec):
//   assurance policies (image/host/function/kubernetes):
//     GET/POST/PUT/DELETE /api/v2/assurance_policy/<type>[/<name>]
//     (client/assurance_policy.go — GetAssurancePolicy/CreateAssurancePolicy/
//      UpdateAssurancePolicy/DeleteAssurancePolicy)
//   runtime policies (container/host):
//     GET/POST/PUT/DELETE /api/v2/runtime_policies[/<name>]
//     (client/runtime_policy.go)
//   firewall policies:
//     GET/POST/PUT/DELETE /api/v2/firewall_policies[/<name>]
//     (client/firewall_policy.go)
//   application scopes:
//     GET/POST/PUT/DELETE /api/v2/access_management/scopes[/<name>]
//     (client/application_scope.go)
//   enforcer groups:
//     GET/POST/PUT/DELETE /api/v1/hostsbatch[/<name>]
//     (client/enforcers.go — the enforcer group's internal object name is
//      "hostsbatch"; DELETE takes ?delete_related=true)
//
// Every write is a named upsert: GET by name to discover whether the object
// exists (200 = update via PUT, 404-shaped "not found" = create via POST).
// Every object created by this app is keyed by an operator-chosen `name`
// (except enforcer groups, keyed by `id`/`group_id`) — the same identity Aqua
// itself uses for uniqueness, so there is no separate id-mapping to persist
// across deploys.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_TIMEOUT_MS = 30_000

/** Read the request timeout (ms) from app settings, falling back to the default. */
export function readTimeoutMs(settings: Record<string, unknown> | undefined): number {
  const raw = settings?.request_timeout_seconds
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw * 1000
  return DEFAULT_TIMEOUT_MS
}

/**
 * Normalize a raw Console base URL into an https base URL with no trailing
 * slash. Accepts a full URL ("https://aqua.example.com"), a bare host
 * ("aqua.example.com") or an http URL (upgraded to https).
 */
export function resolveAquaBaseUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  const withScheme = /^https?:\/\//i.test(value) ? value.replace(/^http:\/\//i, 'https://') : `https://${value}`
  return withScheme.replace(/\/+$/, '')
}

export interface AquaCredential {
  user: string
  password: string
}

/**
 * Resolve the Aqua login credential from a Veltrix credential. Either the
 * "password" auth-type or the "token" auth-type slot works — both are read as
 * the Aqua user's password, mirroring how this codebase's other
 * username+password-only tools (e.g. Cisco ISE) accept either UI picker
 * choice rather than forcing one.
 */
export function resolveAquaCredential(credential: CredentialRef | null): AquaCredential | null {
  if (!credential) return null
  const user = (credential.username ?? '').trim()
  const password = credential.password || credential.apiToken || ''
  if (!user || !password) return null
  return { user, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Aqua Security credential — this app logs into the Aqua Console with a dedicated ' +
  'Aqua user (id/email) and password (Aqua recommends a user with an "API Only" role/permission ' +
  'set for this). Store the user id in the credential "username" field and the password in ' +
  '"password".'

export const MISSING_ENDPOINT_MESSAGE =
  'No Aqua Console base URL configured for this connection — set the Console URL (e.g. ' +
  'https://aqua.example.com) as the connection endpoint.'

export interface AquaResponse {
  status: number
  ok: boolean
  body: string
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

// --- Shared scope/expression model ------------------------------------------
// Mirrors client.Scopes / client.VariableI (assurance_policy.go) and
// client.Scope (runtime_policy.go) — a boolean expression over named
// variables, e.g. expression "v1 && v2" with variables v1/v2 bound to
// (attribute, value) pairs such as { attribute: "image.repo", value: "nginx" }.

export interface AquaScopeVariable {
  attribute: string
  value: string
}
export interface AquaScope {
  expression: string
  variables: AquaScopeVariable[]
}

/** A required/forbidden label constraint — { key, value } (client.Labels). */
export interface AquaLabel {
  key: string
  value: string
}

// --- Assurance policy model (mirror of /api/v2/assurance_policy/<type> JSON) -
// Field subset curated for this app's canvas — the live wire object carries
// many more fields (client.AssurancePolicy has ~90); this app's deploy does a
// read-modify-write, overlaying only the fields below onto whatever GET
// returns, so unmanaged fields on an existing policy are preserved rather
// than silently reset to zero values.

export type AssuranceType = 'image' | 'host' | 'function' | 'kubernetes'

export interface AquaAssurancePolicy {
  name: string
  description?: string
  application_scopes?: string[]
  registries?: string[]
  enabled?: boolean
  enforce?: boolean
  block_failed?: boolean
  fail_cicd?: boolean
  audit_on_failure?: boolean
  enforce_after_days?: number
  cvss_severity_enabled?: boolean
  cvss_severity?: string
  cvss_severity_exclude_no_fix?: boolean
  maximum_score_enabled?: boolean
  maximum_score?: number
  maximum_score_exclude_no_fix?: boolean
  cves_black_list_enabled?: boolean
  cves_black_list?: string[]
  cves_white_list_enabled?: boolean
  cves_white_list?: string[]
  ignore_recently_published_vln?: boolean
  ignore_recently_published_vln_period?: number
  disallow_malware?: boolean
  scan_sensitive_data?: boolean
  packages_black_list_enabled?: boolean
  packages_black_list?: unknown[]
  whitelisted_licenses_enabled?: boolean
  whitelisted_licenses?: string[]
  blacklisted_licenses_enabled?: boolean
  blacklisted_licenses?: string[]
  docker_cis_enabled?: boolean
  kube_cis_enabled?: boolean
  linux_cis_enabled?: boolean
  windows_cis_enabled?: boolean
  openshift_hardening_enabled?: boolean
  only_none_root_users?: boolean
  trusted_base_images_enabled?: boolean
  required_labels_enabled?: boolean
  required_labels?: AquaLabel[]
  forbidden_labels_enabled?: boolean
  forbidden_labels?: AquaLabel[]
  scope?: AquaScope
  // Carried through untouched on read-modify-write.
  [key: string]: unknown
}

// --- Runtime policy model (mirror of /api/v2/runtime_policies JSON) --------

export type RuntimeType = 'container' | 'host'

export interface AquaRuntimePolicy {
  name: string
  description?: string
  application_scopes?: string[]
  enabled?: boolean
  enforce?: boolean
  type?: string
  drift_prevention?: { enabled?: boolean; exec_lockdown?: boolean; image_lockdown?: boolean; exec_lockdown_white_list?: string[] }
  allowed_executables?: { enabled?: boolean; allow_executables?: string[] }
  allowed_registries?: { enabled?: boolean; allowed_registries?: string[] }
  blacklisted_os_users?: { enabled?: boolean; user_black_list?: string[]; group_black_list?: string[] }
  whitelisted_os_users?: { enabled?: boolean; user_white_list?: string[]; group_white_list?: string[] }
  malware_scan_options?: { enabled?: boolean; action?: string }
  file_integrity_monitoring?: { enabled?: boolean }
  container_exec?: { enabled?: boolean; block_container_exec?: boolean }
  reverse_shell?: { enabled?: boolean; block_reverse_shell?: boolean }
  port_block?: { enabled?: boolean; block_inbound_ports?: string[]; block_outbound_ports?: string[] }
  auditing?: {
    enabled?: boolean
    audit_all_processes?: boolean
    audit_all_network?: boolean
  }
  audit_on_failure?: boolean
  scope?: AquaScope
  [key: string]: unknown
}

// --- Firewall policy model (mirror of /api/v2/firewall_policies JSON) ------

export interface AquaNetworkRule {
  allow: boolean
  resource_type: string
  port_range: string
  resource?: string
}

export interface AquaFirewallPolicy {
  name: string
  description?: string
  block_icmp_ping?: boolean
  block_metadata_service?: boolean
  inbound_networks?: AquaNetworkRule[]
  outbound_networks?: AquaNetworkRule[]
  [key: string]: unknown
}

// --- Application scope model (mirror of /api/v2/access_management/scopes) -

export interface AquaScopeCategory {
  expression: string
  variables: AquaScopeVariable[]
}
export interface AquaApplicationScope {
  name: string
  description?: string
  owner_email?: string
  categories?: {
    artifacts?: { image?: AquaScopeCategory }
    workloads?: { kubernetes?: AquaScopeCategory; os?: AquaScopeCategory }
    infrastructure?: { kubernetes?: AquaScopeCategory; os?: AquaScopeCategory }
  }
  [key: string]: unknown
}

// --- Enforcer group model (mirror of /api/v1/hostsbatch JSON) --------------

export interface AquaOrchestrator {
  type: string
  master?: boolean
  service_account?: string
  namespace?: string
}
export interface AquaScheduleScanSettings {
  disabled?: boolean
  is_custom?: boolean
  days?: number[]
  time?: number[]
}
export interface AquaEnforcerGroup {
  id: string
  logicalname?: string
  type: string
  description?: string
  enforce?: boolean
  orchestrator?: AquaOrchestrator
  allowed_applications?: string[]
  allowed_labels?: string[]
  allowed_registries?: string[]
  container_activity_protection?: boolean
  network_protection?: boolean
  host_network_protection?: boolean
  host_protection?: boolean
  host_assurance?: boolean
  image_assurance?: boolean
  admission_control?: boolean
  auto_discovery_enabled?: boolean
  schedule_scan_settings?: AquaScheduleScanSettings
  [key: string]: unknown
}

/** True when a not-found response looks like Aqua's "<object>: <name> not found 404" shape. */
export function isNotFoundError(res: AquaResponse): boolean {
  if (res.status === 404) return true
  return /not found/i.test(res.body) && res.status >= 400
}

/**
 * Thin Aqua CSP/Enterprise Console REST client: session-token auth (login
 * once, cache, re-login once on 401), JSON, bounded timeout. Never throws on
 * HTTP error statuses for read calls — callers inspect `status`; write calls
 * throw with the response body on non-2xx so deploy/rollback fail loudly.
 */
export class AquaClient {
  private readonly baseUrl: string
  private readonly cred: AquaCredential
  private readonly timeoutMs: number
  private token: string | null = null

  constructor(opts: { baseUrl: string; cred: AquaCredential; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** POST /api/v1/login and cache the returned bearer token. */
  private async login(): Promise<{ error?: string }> {
    const res = await this.rawRequest('POST', '/api/v1/login', {
      body: { id: this.cred.user, password: this.cred.password },
      skipAuth: true,
    })
    if (!res.ok) return { error: `Aqua login failed (HTTP ${res.status}): ${res.body.slice(0, 300)}` }
    const parsed = parseJson<{ token?: string }>(res.body)
    if (!parsed?.token) return { error: 'Aqua login succeeded but returned no token.' }
    this.token = parsed.token
    return {}
  }

  private async ensureToken(): Promise<{ error?: string }> {
    if (this.token) return {}
    return this.login()
  }

  private async rawRequest(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; skipAuth?: boolean } = {},
  ): Promise<AquaResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (!opts.skipAuth && this.token) headers.Authorization = `Bearer ${this.token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Whether a login credential was resolved (does not itself perform a network call). */
  hasCredential(): boolean {
    return Boolean(this.cred.user && this.cred.password)
  }

  /**
   * Authenticated request against the Console API. Logs in on first use and
   * re-logs-in exactly once on a 401 (an expired/invalid token), then retries
   * the original call once.
   */
  async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<AquaResponse> {
    const auth = await this.ensureToken()
    if (auth.error) return { status: 0, ok: false, body: auth.error }

    let res = await this.rawRequest(method, path, opts)
    if (res.status === 401) {
      this.token = null
      const relogin = await this.ensureToken()
      if (!relogin.error) res = await this.rawRequest(method, path, opts)
    }
    return res
  }

  private async writeOrThrow(method: string, path: string, body: unknown, okStatuses: number[]): Promise<AquaResponse> {
    const res = await this.request(method, path, { body })
    if (!okStatuses.includes(res.status)) {
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${res.body.slice(0, 400)}`)
    }
    return res
  }

  // --- Assurance policies (/api/v2/assurance_policy/<type>) -----------------

  async getAssurancePolicy(type: AssuranceType, name: string): Promise<AquaAssurancePolicy | null> {
    const res = await this.request('GET', `/api/v2/assurance_policy/${type}/${encodeURIComponent(name)}`)
    if (isNotFoundError(res)) return null
    if (!res.ok) throw new Error(`GET /api/v2/assurance_policy/${type}/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<AquaAssurancePolicy>(res.body)
  }

  async createAssurancePolicy(type: AssuranceType, policy: AquaAssurancePolicy): Promise<void> {
    await this.writeOrThrow('POST', `/api/v2/assurance_policy/${type}`, { ...policy, assurance_type: type }, [200, 201, 204])
  }

  async updateAssurancePolicy(type: AssuranceType, policy: AquaAssurancePolicy): Promise<void> {
    await this.writeOrThrow(
      'PUT',
      `/api/v2/assurance_policy/${type}/${encodeURIComponent(policy.name)}`,
      { ...policy, assurance_type: type },
      [200, 201, 204],
    )
  }

  async deleteAssurancePolicy(type: AssuranceType, name: string): Promise<void> {
    const res = await this.request('DELETE', `/api/v2/assurance_policy/${type}/${encodeURIComponent(name)}`)
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`DELETE /api/v2/assurance_policy/${type}/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Runtime policies (/api/v2/runtime_policies) --------------------------

  async getRuntimePolicy(name: string): Promise<AquaRuntimePolicy | null> {
    const res = await this.request('GET', `/api/v2/runtime_policies/${encodeURIComponent(name)}`)
    if (isNotFoundError(res)) return null
    if (!res.ok) throw new Error(`GET /api/v2/runtime_policies/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<AquaRuntimePolicy>(res.body)
  }

  async createRuntimePolicy(policy: AquaRuntimePolicy): Promise<void> {
    await this.writeOrThrow('POST', '/api/v2/runtime_policies', policy, [200, 201, 204])
  }

  async updateRuntimePolicy(policy: AquaRuntimePolicy): Promise<void> {
    await this.writeOrThrow('PUT', `/api/v2/runtime_policies/${encodeURIComponent(policy.name)}`, policy, [200, 201, 204])
  }

  async deleteRuntimePolicy(name: string): Promise<void> {
    const res = await this.request('DELETE', `/api/v2/runtime_policies/${encodeURIComponent(name)}`)
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`DELETE /api/v2/runtime_policies/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Firewall policies (/api/v2/firewall_policies) ------------------------

  async getFirewallPolicy(name: string): Promise<AquaFirewallPolicy | null> {
    const res = await this.request('GET', `/api/v2/firewall_policies/${encodeURIComponent(name)}`)
    if (isNotFoundError(res)) return null
    if (!res.ok) throw new Error(`GET /api/v2/firewall_policies/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<AquaFirewallPolicy>(res.body)
  }

  async createFirewallPolicy(policy: AquaFirewallPolicy): Promise<void> {
    await this.writeOrThrow('POST', '/api/v2/firewall_policies', policy, [200, 201, 204])
  }

  async updateFirewallPolicy(policy: AquaFirewallPolicy): Promise<void> {
    await this.writeOrThrow('PUT', `/api/v2/firewall_policies/${encodeURIComponent(policy.name)}`, policy, [200, 201, 204])
  }

  async deleteFirewallPolicy(name: string): Promise<void> {
    const res = await this.request('DELETE', `/api/v2/firewall_policies/${encodeURIComponent(name)}`)
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`DELETE /api/v2/firewall_policies/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Application scopes (/api/v2/access_management/scopes) ---------------

  async getApplicationScope(name: string): Promise<AquaApplicationScope | null> {
    const res = await this.request('GET', `/api/v2/access_management/scopes/${encodeURIComponent(name)}`)
    if (isNotFoundError(res)) return null
    if (!res.ok) throw new Error(`GET /api/v2/access_management/scopes/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    return parseJson<AquaApplicationScope>(res.body)
  }

  async createApplicationScope(scope: AquaApplicationScope): Promise<void> {
    await this.writeOrThrow('POST', '/api/v2/access_management/scopes', scope, [200, 201, 204])
  }

  async updateApplicationScope(scope: AquaApplicationScope): Promise<void> {
    await this.writeOrThrow('PUT', `/api/v2/access_management/scopes/${encodeURIComponent(scope.name)}`, scope, [200, 201, 204])
  }

  async deleteApplicationScope(name: string): Promise<void> {
    const res = await this.request('DELETE', `/api/v2/access_management/scopes/${encodeURIComponent(name)}`)
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`DELETE /api/v2/access_management/scopes/${name} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }

  // --- Enforcer groups (/api/v1/hostsbatch) ---------------------------------
  // Update is a bare PUT (no path id) — the group's `id` in the body IS the
  // identity, mirrored from the official client (UpdateEnforcerGroup passes
  // update_enforcers=true so a change propagates to already-installed
  // Enforcers in the group rather than only affecting future installs).

  async getEnforcerGroup(id: string): Promise<AquaEnforcerGroup | null> {
    const res = await this.request('GET', `/api/v1/hostsbatch/${encodeURIComponent(id)}`)
    if (isNotFoundError(res)) return null
    if (!res.ok) throw new Error(`GET /api/v1/hostsbatch/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    const parsed = parseJson<AquaEnforcerGroup>(res.body)
    return parsed && parsed.id ? parsed : null
  }

  async createEnforcerGroup(group: AquaEnforcerGroup): Promise<void> {
    await this.writeOrThrow('POST', '/api/v1/hostsbatch', group, [200, 201, 204])
  }

  async updateEnforcerGroup(group: AquaEnforcerGroup): Promise<void> {
    await this.writeOrThrow('PUT', '/api/v1/hostsbatch', group, [200, 201, 204])
  }

  async deleteEnforcerGroup(id: string): Promise<void> {
    const res = await this.request('DELETE', `/api/v1/hostsbatch/${encodeURIComponent(id)}?delete_related=true`)
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
      throw new Error(`DELETE /api/v1/hostsbatch/${id} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
    }
  }
}

/** Build an AquaClient from handler context pieces, or the reason it cannot be built. */
export function buildAquaClient(
  endpoint: string | null,
  credential: CredentialRef | null,
  settings?: Record<string, unknown>,
): { client: AquaClient; baseUrl: string } | { error: string } {
  const baseUrl = resolveAquaBaseUrl(endpoint)
  if (!baseUrl) return { error: MISSING_ENDPOINT_MESSAGE }
  const cred = resolveAquaCredential(credential)
  if (!cred) return { error: MISSING_CREDENTIAL_MESSAGE }
  return {
    client: new AquaClient({ baseUrl, cred, timeoutMs: readTimeoutMs(settings) }),
    baseUrl,
  }
}
