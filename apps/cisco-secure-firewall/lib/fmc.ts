// =============================================================================
// Cisco Secure Firewall Management Center (FMC) REST API client.
//
// FMC's automation surface is a domain-scoped JSON REST API:
//   https://<fmc-host>/api/fmc_config/v1/domain/{DOMAIN_UUID}/<resource>
// documented at developer.cisco.com/docs/firepower and verified directly
// against the CiscoDevNet/terraform-provider-fmc source (a Cisco-maintained
// provider whose `gen/definitions/*.yaml` files are 1:1 declarations of each
// REST endpoint + JSON shape) and its `netascode/go-fmc` HTTP client
// dependency, not assumed from documentation prose.
//
// Auth (verified against netascode/go-fmc's client.go `login()`):
//   POST /api/fmc_platform/v1/auth/generatetoken
//     - HTTP Basic auth (username/password), empty body
//     - Success: HTTP 204 with NO body, and the tokens/domain list arrive as
//       response HEADERS, not JSON:
//         X-auth-access-token   - bearer-style token sent on every request
//         X-auth-refresh-token  - used by /auth/refreshtoken (not used here -
//                                 this client re-logs-in on 401 instead, the
//                                 same pragmatic pattern this catalog's other
//                                 session-based apps use, e.g.
//                                 apps/teleport/lib/teleport.ts)
//         DOMAIN_UUID           - the UUID of the user's own login domain
//         DOMAINS               - JSON array of every domain the user can see:
//                                 [{"name":"Global","uuid":"..."}, ...]
//   Every subsequent request sends `X-auth-access-token: <token>` (NOT an
//   `Authorization: Bearer` header - FMC's own header name).
//
// Domain scoping: every `/fmc_config/v1/domain/{DOMAIN_UUID}/...` path needs a
// domain UUID. This client resolves it from the `domain_name` app setting
// (looked up case-insensitively in the DOMAINS list) or, when unset, falls
// back to the DOMAIN_UUID the login response reported for the connecting
// user - correct for the overwhelmingly common single/Global-domain
// deployment (mirrors apps/teleport's `cluster_name` auto-detect precedent).
//
// Objects are identified by a server-assigned UUID, not by name - unlike
// Panorama's name-keyed REST API. Upsert-by-name is therefore always: list the
// collection, find a case-insensitive name match, then PUT .../<id> (update)
// or POST .../ (create) - see `upsertByName` below, the FMC analogue of
// apps/palo-alto-panorama/lib/panorama.ts's `upsertObjects`.
//
// Pagination (verified against go-fmc's `Get()`): list responses carry
// `{"items":[...], "paging":{"offset":...,"limit":...,"count":...}}`; more
// pages exist while the number of items returned equals the requested limit.
//
// Error shape (verified against go-fmc's `Do()`): FMC error bodies are
// `{"error":{"category":"...","messages":[{"description":"...","field":"..."}]}}`.
//
// TLS: FMC management certs are commonly self-signed. Handlers run in-process
// and cannot install a custom fetch dispatcher, so this client cannot disable
// TLS verification - the platform host must trust the FMC certificate.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const DEFAULT_TIMEOUT_MS = 30_000
/** go-fmc paginates 1000 items/page by default; a smaller page keeps any single request light. */
const LIST_PAGE_SIZE = 200
/** Hard stop on pagination so a misbehaving server can never spin this forever. */
const MAX_LIST_PAGES = 100

export interface FmcSettings {
  /** Explicit domain name override; falls back to the login user's own domain when unset. */
  domainName: string | null
  timeoutMs: number
  /** When true, deploy/rollback additionally trigger a deploy-to-devices activation. See deployToDevices(). */
  autoDeployToDevices: boolean
  /** Passed through to POST /deployment/deploymentrequests as `ignoreWarning`. */
  ignoreDeployWarnings: boolean
}

export function readFmcSettings(settings: Record<string, unknown>): FmcSettings {
  const rawDomain = settings.domain_name
  const domainName = typeof rawDomain === 'string' && rawDomain.trim().length > 0 ? rawDomain.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS

  return {
    domainName,
    timeoutMs,
    autoDeployToDevices: coerceBoolean(settings.auto_deploy_to_devices, false),
    ignoreDeployWarnings: coerceBoolean(settings.ignore_deploy_warnings, true),
  }
}

export interface FmcCredential {
  username: string
  password: string
}

/** FMC authenticates with a local/RBAC username + password - stored as the credential's username/password. */
export function resolveFmcCredential(credential: CredentialRef | null): FmcCredential | null {
  if (!credential) return null
  const username = (credential.username ?? '').trim()
  const password = credential.password ?? ''
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable FMC credential - store an FMC user\'s username in the credential "username" field and its ' +
  'password in "password". The user needs read/write access (an Administrator, Access Admin or Network ' +
  'Admin role, scoped to what this app manages) in the target domain.'

export interface FmcResponse {
  status: number
  ok: boolean
  body: string
}

export type FmcMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** One object as FMC returns it: at minimum an id, name and type; everything else is resource-specific. */
export interface FmcObject {
  id?: string
  name?: string
  type?: string
  [key: string]: unknown
}

interface FmcSession {
  accessToken: string
  domainUuid: string
  domains: Map<string, string>
}

export function parseJson<T>(body: string): T | null {
  const text = (body ?? '').trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Human-readable message from an FMC error body (`{"error":{"messages":[{"description":...}]}}`). */
export function fmcErrorMessage(res: FmcResponse): string {
  const parsed = parseJson<{ error?: { messages?: Array<{ description?: string; field?: string }> } }>(res.body)
  const messages = parsed?.error?.messages
  if (messages && messages.length > 0) {
    return messages
      .map((m) => (m.field ? `${m.field}: ${m.description ?? 'invalid'}` : m.description ?? 'invalid'))
      .join('; ')
  }
  return res.body?.trim() ? res.body.trim().slice(0, 300) : `HTTP ${res.status}`
}

/** Parse the `DOMAINS` login-response header: a JSON array of `{name, uuid}`. */
function parseDomainsHeader(raw: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!raw) return map
  const parsed = parseJson<Array<{ name?: string; uuid?: string }>>(raw)
  for (const entry of parsed ?? []) {
    if (typeof entry.name === 'string' && typeof entry.uuid === 'string') {
      map.set(entry.name, entry.uuid)
    }
  }
  return map
}

export class FmcClient {
  private readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private readonly timeoutMs: number
  private readonly domainNameOverride: string | null
  private session: FmcSession | null = null

  constructor(opts: {
    baseUrl: string
    username: string
    password: string
    timeoutMs: number
    domainName: string | null
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.username = opts.username
    this.password = opts.password
    this.timeoutMs = opts.timeoutMs
    this.domainNameOverride = opts.domainName
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
   * POST /api/fmc_platform/v1/auth/generatetoken with HTTP Basic auth. Success
   * is HTTP 204 with the token/domain data in response headers (see module
   * comment) - there is no JSON body to parse on the happy path.
   */
  private async login(): Promise<void> {
    const basic = Buffer.from(`${this.username}:${this.password}`).toString('base64')
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/fmc_platform/v1/auth/generatetoken`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
    })

    if (res.status !== 204) {
      const text = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `FMC rejected the login (HTTP ${res.status}). Check the username and password, and that the ` +
            'user is not locked out or required to change its password.',
        )
      }
      throw new Error(`FMC login failed (HTTP ${res.status}): ${text ? text.slice(0, 300) : 'no response body'}`)
    }

    const accessToken = res.headers.get('X-auth-access-token')
    const domainUuid = res.headers.get('DOMAIN_UUID')
    if (!accessToken || !domainUuid) {
      throw new Error(
        'FMC login succeeded (HTTP 204) but did not return the expected X-auth-access-token / DOMAIN_UUID headers.',
      )
    }
    const domains = parseDomainsHeader(res.headers.get('DOMAINS'))
    if (domains.size === 0) domains.set('Global', domainUuid)

    this.session = { accessToken, domainUuid, domains }
  }

  private async ensureSession(): Promise<FmcSession> {
    if (!this.session) await this.login()
    return this.session as FmcSession
  }

  /**
   * Resolve the `{DOMAIN_UUID}` path segment: the `domain_name` setting
   * (case-insensitive match against the login's DOMAINS list) when set,
   * otherwise the connecting user's own login domain - correct for the
   * overwhelmingly common single/Global-domain deployment.
   */
  async resolveDomainUuid(): Promise<string> {
    const session = await this.ensureSession()
    if (!this.domainNameOverride) return session.domainUuid

    for (const [name, uuid] of session.domains) {
      if (name.toLowerCase() === this.domainNameOverride.toLowerCase()) return uuid
    }
    const available = [...session.domains.keys()].join(', ') || '(none reported)'
    throw new Error(
      `Domain "${this.domainNameOverride}" was not found for this FMC user. Domains available: ${available}.`,
    )
  }

  /** Issue an authenticated request, retrying once with a fresh login on a 401 (expired/invalid session). */
  async request(
    method: FmcMethod,
    path: string,
    opts: { query?: Record<string, string | number>; body?: unknown } = {},
  ): Promise<FmcResponse> {
    const attempt = async (retryOn401: boolean): Promise<FmcResponse> => {
      const session = await this.ensureSession()
      const domainUuid = await this.resolveDomainUuid()
      const url = new URL(`${this.baseUrl}${path.replace('{DOMAIN_UUID}', domainUuid)}`)
      for (const [key, value] of Object.entries(opts.query ?? {})) {
        url.searchParams.set(key, String(value))
      }

      const res = await this.fetchWithTimeout(url.toString(), {
        method,
        headers: {
          'X-auth-access-token': session.accessToken,
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

  /**
   * List every object at `path`, following FMC's offset/limit pagination
   * (verified against go-fmc's `Get()`: keep paging while a full page came
   * back). Returns an empty list (not an error) for a resource an FMC edition
   * doesn't expose.
   */
  async list(path: string): Promise<{ ok: boolean; items: FmcObject[]; status: number; body: string }> {
    const items: FmcObject[] = []
    let offset = 0
    let lastRes: FmcResponse = { status: 200, ok: true, body: '' }

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      lastRes = await this.request('GET', path, { query: { offset, limit: LIST_PAGE_SIZE, expanded: 'true' } })
      if (!lastRes.ok) return { ok: false, items: [], status: lastRes.status, body: lastRes.body }

      const parsed = parseJson<{ items?: FmcObject[] }>(lastRes.body)
      const pageItems = parsed?.items ?? []
      items.push(...pageItems)
      if (pageItems.length < LIST_PAGE_SIZE) break
      offset += LIST_PAGE_SIZE
    }

    return { ok: true, items, status: lastRes.status, body: lastRes.body }
  }

  /** GET one object by id; null on 404. */
  async getById(path: string, id: string): Promise<{ ok: boolean; item: FmcObject | null; status: number; body: string }> {
    const res = await this.request('GET', `${path}/${encodeURIComponent(id)}`)
    if (res.status === 404) return { ok: true, item: null, status: res.status, body: res.body }
    if (!res.ok) return { ok: false, item: null, status: res.status, body: res.body }
    return { ok: true, item: parseJson<FmcObject>(res.body), status: res.status, body: res.body }
  }

  createObject(path: string, body: Record<string, unknown>): Promise<FmcResponse> {
    return this.request('POST', path, { body })
  }

  updateObject(path: string, id: string, body: Record<string, unknown>): Promise<FmcResponse> {
    return this.request('PUT', `${path}/${encodeURIComponent(id)}`, { body: { id, ...body } })
  }

  deleteObject(path: string, id: string): Promise<FmcResponse> {
    return this.request('DELETE', `${path}/${encodeURIComponent(id)}`)
  }

  /** Find one object by exact, case-insensitive name match within a collection. */
  async findByName(path: string, name: string): Promise<FmcObject | null> {
    const listed = await this.list(path)
    if (!listed.ok) return null
    const target = name.trim().toLowerCase()
    return listed.items.find((item) => (item.name ?? '').toLowerCase() === target) ?? null
  }
}

export interface BuiltFmcClient {
  client: FmcClient
  fmcUrl: string
  settings: FmcSettings
}

/** Build an FmcClient from a component hostname, a credential and app settings, or the reason it cannot be built. */
export function buildFmcClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): BuiltFmcClient | { error: string } {
  const creds = resolveFmcCredential(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = (hostname ?? '').trim()
  if (!host) {
    return {
      error: 'No FMC host - register a component whose hostname is the FMC management address (e.g. fmc.example.com). HTTPS is always used.',
    }
  }
  const baseUrl = host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`

  const resolved = readFmcSettings(settings)
  const client = new FmcClient({
    baseUrl,
    username: creds.username,
    password: creds.password,
    timeoutMs: resolved.timeoutMs,
    domainName: resolved.domainName,
  })
  return { client, fmcUrl: baseUrl, settings: resolved }
}

// --- Generic name-keyed upsert orchestration (shared by every flat object type) ---

/** One object to upsert: a name plus its FMC-specific body fields (id/name/type are added by the caller). */
export interface UpsertSpec {
  name: string
  fields: Record<string, unknown>
}

/** What deploy did to one object, captured for rollback. NON-UNION (id/name/existed always present). */
export interface DeployedObject {
  name: string
  id: string
  existed: boolean
}

/**
 * Upsert each spec at `path`: PUT an existing (by case-insensitive name match)
 * object, or POST a new one. Tracks what was created vs. updated so rollback
 * can delete only what it created - the FMC analogue of
 * apps/palo-alto-panorama/lib/panorama.ts's `upsertObjects`, adapted for an
 * id-keyed (not name-keyed) REST surface. Throws on the first API error; the
 * caller returns the partial rollback state already accumulated.
 */
export async function upsertByName(
  client: FmcClient,
  path: string,
  specs: UpsertSpec[],
  rollback: DeployedObject[],
  deployed: string[],
): Promise<void> {
  const listed = await client.list(path)
  if (!listed.ok) {
    throw new Error(`Failed to list existing objects at ${path}: HTTP ${listed.status}`)
  }
  const byName = new Map(listed.items.map((item) => [(item.name ?? '').toLowerCase(), item]))

  for (const spec of specs) {
    const existing = byName.get(spec.name.toLowerCase())
    const body = { name: spec.name, ...spec.fields }

    if (existing?.id) {
      const res = await client.updateObject(path, existing.id, body)
      if (!res.ok) throw new Error(`Failed to update "${spec.name}": ${fmcErrorMessage(res)}`)
      rollback.push({ name: spec.name, id: existing.id, existed: true })
    } else {
      const res = await client.createObject(path, body)
      if (!res.ok) throw new Error(`Failed to create "${spec.name}": ${fmcErrorMessage(res)}`)
      const created = parseJson<FmcObject>(res.body)
      if (!created?.id) throw new Error(`FMC created "${spec.name}" but returned no id`)
      rollback.push({ name: spec.name, id: created.id, existed: false })
    }
    deployed.push(spec.name)
  }
}

// --- Deploy-to-devices: the one-shot activation step, never a config type ----
//
// Writing to /object/* or /policy/* only edits FMC's own configuration
// database. Pushing that configuration onto the managed firewalls (FTDs) is a
// SEPARATE, one-shot activation action - POST /deployment/deploymentrequests -
// the FMC analogue of a Panorama commit-and-push or a Zscaler activation. It
// has no stable "current state" to declare or drift-check (a deployment
// request is a fire-and-forget job, not an object), so - exactly like
// apps/palo-alto-panorama's commit model - it is NEVER modeled as a
// configuration type here. Instead it is an opt-in side effect of every
// successful deploy/rollback, gated by the `auto_deploy_to_devices` setting.
//
// `/deployment/deploymentrequests` itself is confirmed read/write (POST-only:
// no_data_source/no_import/no_update/no_delete) by
// terraform-provider-fmc's gen/definitions/device_deploy.yaml. The pending-
// changes discovery step this helper uses first -
// GET /deployment/deployabledevices - is Cisco's documented FMC REST API
// workflow for finding which devices have queued changes (the terraform
// provider itself always requires an explicit, caller-supplied device list
// rather than auto-discovering one, so this pairing was not re-verified
// against that provider's source - flagged here rather than left silent).

export const DEPLOYMENT_REQUESTS_PATH = '/deployment/deploymentrequests'
export const DEPLOYABLE_DEVICES_PATH = '/deployment/deployabledevices'

export interface DeployToDevicesOutcome {
  attempted: boolean
  triggered: boolean
  deviceCount: number
  message: string
}

/**
 * When `auto_deploy_to_devices` is enabled: find devices with pending changes
 * and trigger a deployment to them. Never throws - a failure here is reported
 * in the returned message so it can never mask an otherwise-successful config
 * write.
 */
export async function deployToDevicesIfEnabled(
  client: FmcClient,
  settings: FmcSettings,
): Promise<DeployToDevicesOutcome> {
  if (!settings.autoDeployToDevices) {
    return {
      attempted: false,
      triggered: false,
      deviceCount: 0,
      message: 'Configuration written but NOT deployed to devices (auto_deploy_to_devices is off) - deploy from FMC to activate on managed firewalls.',
    }
  }

  try {
    const listed = await client.list(DEPLOYABLE_DEVICES_PATH)
    if (!listed.ok) {
      return {
        attempted: true,
        triggered: false,
        deviceCount: 0,
        message: `Could not list deployable devices (HTTP ${listed.status}) - deploy manually from FMC to activate this change.`,
      }
    }
    const deviceIds = listed.items.map((d) => d.id).filter((id): id is string => typeof id === 'string')
    if (deviceIds.length === 0) {
      return { attempted: true, triggered: false, deviceCount: 0, message: 'No devices have pending changes to deploy.' }
    }

    const res = await client.createObject(DEPLOYMENT_REQUESTS_PATH, {
      type: 'DeploymentRequest',
      deviceList: deviceIds,
      ignoreWarning: settings.ignoreDeployWarnings,
      deploymentNote: 'Veltrix Security-as-Code deploy',
    })
    if (!res.ok) {
      return {
        attempted: true,
        triggered: false,
        deviceCount: deviceIds.length,
        message: `Deploy-to-devices request failed: ${fmcErrorMessage(res)}. Deploy manually from FMC to activate this change.`,
      }
    }
    return {
      attempted: true,
      triggered: true,
      deviceCount: deviceIds.length,
      message: `Triggered deployment to ${deviceIds.length} device(s).`,
    }
  } catch (error) {
    return {
      attempted: true,
      triggered: false,
      deviceCount: 0,
      message: `Deploy-to-devices errored: ${error instanceof Error ? error.message : 'unknown error'} - deploy manually from FMC.`,
    }
  }
}

export function coerceBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1' || value === 'yes') return true
  if (value === 'false' || value === 0 || value === '0' || value === 'no') return false
  return defaultValue
}

/** Split a comma/newline separated canvas value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Order-insensitive, case-insensitive equality of two string lists. */
export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b.map((s) => s.toLowerCase()))
  return a.every((item) => bSet.has(item.toLowerCase()))
}
