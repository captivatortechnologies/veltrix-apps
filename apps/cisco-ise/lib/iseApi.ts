// =============================================================================
// Cisco ISE — External RESTful Services (ERS) API client.
//
// ERS is a separate management plane from the ISE admin GUI/pxGrid: a REST API
// on its own fixed HTTPS port that must be explicitly enabled per PAN/admin node
// (Administration > System > Settings > API Settings > ERS Settings — "Enable
// ERS for Read/Write"). Until enabled, the port is closed and every request
// times out rather than returning an HTTP error.
//   https://developer.cisco.com/identity-services-engine/
//   https://developer.cisco.com/docs/identity-services-engine/latest/endpointgroup/
//
// Auth is plain HTTP Basic on EVERY request (no token exchange, no session) —
// credentials belong to an ISE administrator in the ERS-Admin or ERS-Operator
// group. ERS supports both XML and JSON; this client always sends and requests
// JSON (`Accept` / `Content-Type: application/json`).
//
// Every resource (endpoint groups, network devices, identity groups, ...) shares
// the same envelope conventions:
//   - a LIST (GET .../<resource>) returns `{ SearchResult: { total, resources: [
//     { id, name, description, link: { rel, href, type } }, ... ] } }` — the
//     resources are SUMMARIES ONLY (no full detail); filter via `?filter=
//     name.EQ.<value>` to find one by name, or `?size=1` as a cheap reachability
//     probe.
//   - a SINGLE resource (GET/POST/PUT .../<resource>[/<id>]) is wrapped in a key
//     matching its type, e.g. `{ "EndPointGroup": { id, name, description,
//     systemDefined, link } }`.
//   - a successful POST returns 201 with an empty body and the new resource's
//     URL in the `Location` header (`.../endpointgroup/<id>`); PUT/DELETE return
//     200/204 with an empty body.
//   - a failure returns `{ ERSResponse: { messages: [{ title, type, code }] } }`.
// This is the ERS convention used uniformly across every resource type; the
// endpoint-group-specific pieces (its own field set) were verified directly
// against the docs above and Cisco's own ERS examples. FLAG: exercise once
// against a live ISE node before treating an edge case (e.g. the exact
// ERSResponse failure shape) as final.
//
// Self-hosted ISE ships a self-signed certificate on the ERS port until an
// administrator installs a CA-signed one, so the transport tolerates an
// untrusted cert by default (same posture as this platform's other on-prem
// REST clients — Wazuh, Graylog) via node:https directly, gated by the
// `verify_tls` app setting (default off).
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

/** ERS is fixed to this HTTPS port on every ISE PAN/admin node. */
export const DEFAULT_ERS_PORT = 9060

const DEFAULT_TIMEOUT_MS = 30_000

type ProviderLike = { config?: Record<string, unknown> | null } | null

// --- Settings ----------------------------------------------------------------

export interface IseSettings {
  /** Enforce a valid TLS certificate on the ERS endpoint. Off by default. */
  verifyTls: boolean
  timeoutMs: number
}

export function readIseSettings(settings: Record<string, unknown>): IseSettings {
  const verifyTls = settings.verify_tls === true
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS
  return { verifyTls, timeoutMs }
}

// --- Endpoint resolution -------------------------------------------------------

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/**
 * Base URL for the ERS config API (no trailing slash, no `/ers/config` suffix —
 * callers append it). The connection endpoint (component hostname) is the ISE
 * PAN/admin node; the port defaults to the fixed ERS port (9060) unless the
 * connection's endpoint explicitly named a different one (e.g. behind a proxy).
 */
export function buildIseUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  const host = resolveHost(component, connectivity, provider)
  const port = Number(component.port) || DEFAULT_ERS_PORT
  return `https://${host}:${port}`
}

/** Base ERS config path — every resource lives under this. */
export function ersBase(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  return `${buildIseUrl(component, connectivity, provider)}/ers/config`
}

// --- Credentials ---------------------------------------------------------------

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable ISE ERS credential — this app authenticates with HTTP Basic auth using an ISE ' +
  'administrator in the ERS-Admin (or ERS-Operator for read-only) group. Store that username in ' +
  'the credential "username" field and its password in "password".'

export const MISSING_ENDPOINT_MESSAGE =
  'No ISE endpoint configured for this connection — set the PAN/admin node hostname (and ERS port, ' +
  'default 9060) when adding the connection.'

/**
 * ERS Basic-auth header. The secret is read from `password` first, falling back
 * to `apiToken` — the Connections UI stores whichever field the operator's
 * chosen auth method populates, and ERS itself only ever wants a plain
 * username + password pair.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  const user = (credential.username ?? '').trim()
  const pass = credential.password || credential.apiToken || ''
  if (!user || !pass) return {}
  return { Authorization: `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}` }
}

export function hasUsableCredential(credential: CredentialRef | null | undefined): credential is CredentialRef {
  if (!credential) return false
  return Boolean((credential.username ?? '').trim() && (credential.password || credential.apiToken))
}

// --- Transport -------------------------------------------------------------

export interface IseResponse {
  status: number
  ok: boolean
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * One HTTPS request against the ERS API. Uses node:https directly (not fetch)
 * so `rejectUnauthorized` can be toggled per the `verify_tls` setting — the
 * platform's global fetch stack always verifies, which would reject ISE's
 * default self-signed certificate.
 */
export function iseRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<IseResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || DEFAULT_ERS_PORT,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: init.verifyTls === true,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ status, ok: status >= 200 && status < 300, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
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
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** ERS failure envelope: `{ ERSResponse: { messages: [{ title, type, code }] } }`. */
export interface ErsErrorEnvelope {
  ERSResponse?: { messages?: Array<{ title?: string; type?: string; code?: string }> }
}

/** A short, human-readable message for a non-2xx ERS response. */
export function ersErrorMessage(res: IseResponse): string {
  const parsed = parseJson<ErsErrorEnvelope>(res.body)
  const messages = parsed?.ERSResponse?.messages
  if (Array.isArray(messages) && messages.length > 0) {
    return messages.map((m) => m.title || m.code || 'unknown ERS error').join('; ')
  }
  const trimmed = (res.body ?? '').replace(/\s+/g, ' ').trim()
  if (trimmed) return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
  return `HTTP ${res.status}`
}

async function getJson<T>(url: string, headers: Record<string, string>, opts: { verifyTls: boolean; timeoutMs: number }): Promise<T> {
  const res = await iseRequest(url, { headers, verifyTls: opts.verifyTls, timeoutMs: opts.timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}: ${ersErrorMessage(res)}`)
  return (parseJson<T>(res.body) ?? ({} as T))
}

// --- Generic ERS envelopes ---------------------------------------------------

/** The `link` object every ERS resource (summary or full) carries. */
export interface ErsLink {
  rel?: string
  href?: string
  type?: string
}

/** The lightweight summary ERS returns inside a SearchResult list. */
export interface ErsResourceSummary {
  id: string
  name: string
  description?: string
  link?: ErsLink
}

interface SearchResultEnvelope {
  SearchResult?: {
    total?: number
    resources?: ErsResourceSummary[]
  }
}

export function summariesFromSearchResult(list: unknown): ErsResourceSummary[] {
  const resources = (list as SearchResultEnvelope | null)?.SearchResult?.resources
  return Array.isArray(resources) ? resources : []
}

/** Unwrap a single-resource ERS envelope, e.g. `{ EndPointGroup: {...} }`. */
export function unwrapErsResource<T>(envelope: unknown, wrapperKey: string): T | null {
  const record = envelope as Record<string, unknown> | null
  return (record?.[wrapperKey] as T | undefined) ?? null
}

/**
 * ERS's own id-from-Location convention: a successful POST returns the new
 * resource's URL (`.../ers/config/<resource>/<id>`) in the `Location` response
 * header, with no body. Falls back to null when absent so callers can
 * re-resolve the id by name instead of trusting a guess.
 */
export function idFromLocationHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers.location
  const location = Array.isArray(raw) ? raw[0] : raw
  if (!location) return null
  const match = /\/([^/]+)\/?$/.exec(location.trim())
  return match ? decodeURIComponent(match[1]) : null
}

// --- Generic ERS resource client ---------------------------------------------

export interface ErsResourceClient<T> {
  /** List every resource (summaries only — id/name/description/link). */
  list(): Promise<ErsResourceSummary[]>
  /** Find one resource by exact name via the ERS name filter. Null when not found. */
  findByName(name: string): Promise<ErsResourceSummary | null>
  /** Full detail for a resource by id. Null on a 404. */
  getById(id: string): Promise<T | null>
  /** Create a resource; returns the new id (from Location, falling back to a name lookup). */
  create(body: Omit<T, 'id'>): Promise<string>
  /** Replace a resource's editable fields by id. */
  update(id: string, body: Omit<T, 'id'>): Promise<void>
  remove(id: string): Promise<void>
  /** Cheap reachability probe: GET .../<resource>?size=1. Throws on failure. */
  probe(): Promise<{ total: number }>
}

/**
 * Build a client bound to one ERS resource (endpointgroup, networkdevicegroup,
 * networkdevice, authorizationprofile, ...) on one ISE connection. Every ERS
 * resource shares the same list/get/create/update/delete conventions (see the
 * module doc) — only the URL segment, the single-resource envelope's wrapper
 * key, and the resource's own field set differ, so this is the ONE transport
 * implementation every config type's `lib` usage builds on (DRY — see each
 * config type's `_shared.ts` for its resource-specific field mapping).
 */
export function buildErsResourceClient<T extends { id?: string; name: string }>(
  base: string,
  resourceSegment: string,
  wrapperKey: string,
  credential: CredentialRef,
  settings: IseSettings,
): ErsResourceClient<T> {
  const headers = buildAuthHeader(credential)
  const resource = `${base}/${resourceSegment}`
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' }
  const opts = { verifyTls: settings.verifyTls, timeoutMs: settings.timeoutMs }

  const client: ErsResourceClient<T> = {
    async list() {
      return summariesFromSearchResult(await getJson<unknown>(resource, headers, opts))
    },

    async findByName(name: string) {
      const url = `${resource}?filter=${encodeURIComponent(`name.EQ.${name}`)}`
      const matches = summariesFromSearchResult(await getJson<unknown>(url, headers, opts))
      return matches.find((m) => m.name === name) ?? matches[0] ?? null
    },

    async getById(id: string) {
      const res = await iseRequest(`${resource}/${encodeURIComponent(id)}`, { headers, ...opts })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${resource}/${id} -> HTTP ${res.status}: ${ersErrorMessage(res)}`)
      return unwrapErsResource<T>(parseJson(res.body), wrapperKey)
    },

    async create(body) {
      const envelope = { [wrapperKey]: body }
      const res = await iseRequest(resource, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(envelope), ...opts })
      if (!res.ok) throw new Error(`POST ${resource} -> HTTP ${res.status}: ${ersErrorMessage(res)}`)
      const idFromHeader = idFromLocationHeader(res.headers)
      if (idFromHeader) return idFromHeader
      // Defensive fallback — some ERS builds omit Location on a 201; re-resolve by name.
      const name = (body as { name?: string }).name ?? ''
      const created = name ? await client.findByName(name) : null
      if (!created) throw new Error(`Created "${name}" (${wrapperKey}) but could not resolve its id`)
      return created.id
    },

    async update(id, body) {
      const envelope = { [wrapperKey]: { id, ...body } }
      const res = await iseRequest(`${resource}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(envelope),
        ...opts,
      })
      if (!res.ok) throw new Error(`PUT ${resource}/${id} -> HTTP ${res.status}: ${ersErrorMessage(res)}`)
    },

    async remove(id) {
      const res = await iseRequest(`${resource}/${encodeURIComponent(id)}`, { method: 'DELETE', headers, ...opts })
      if (!res.ok && res.status !== 404) throw new Error(`DELETE ${resource}/${id} -> HTTP ${res.status}: ${ersErrorMessage(res)}`)
    },

    async probe() {
      const res = await iseRequest(`${resource}?size=1`, { headers, ...opts })
      if (!res.ok) throw new Error(`GET ${resource}?size=1 -> HTTP ${res.status}: ${ersErrorMessage(res)}`)
      const parsed = parseJson<SearchResultEnvelope>(res.body)
      return { total: parsed?.SearchResult?.total ?? 0 }
    },
  }

  return client
}

// --- Endpoint Identity Group (EndPointGroup) resource — /ers/config/endpointgroup ---
// https://developer.cisco.com/docs/identity-services-engine/latest/endpointgroup/

/** The full resource as read from / written to a single-resource ERS call. */
export interface EndPointGroup {
  id?: string
  name: string
  description?: string
  /** Always false for anything this app creates — non-system-defined groups only. */
  systemDefined?: boolean
  link?: ErsLink
}

// --- Network Device Group (NetworkDeviceGroup) resource — /ers/config/networkdevicegroup ---
//
// Verified against the community pyise-ers ERS client (add_device_group /
// update_device_group — github.com/falkowich/pyise-ers, pyiseers/pyiseers.py),
// which is exercised against real ISE deployments. `name` is the FULL
// "#"-separated path from the NDG root (e.g. "Location#All Locations#SF",
// "Device Type#All Device Types#Switches"); `othername` is just the root
// category — the first "#" segment of `name` (built-in roots are "Location",
// "Device Type" and "IPSEC"; ISE also allows custom root categories).
//
// CORRECTION: the coordinator's spec named this field "ndgtype" — the verified
// ERS field is actually **"othername"**. Implemented with the verified name.
export interface NetworkDeviceGroup {
  id?: string
  name: string
  description?: string
  othername?: string
  link?: ErsLink
}

/** Derive `othername` (the NDG root category) from a "#"-separated `name`. */
export function ndgRootFromName(name: string): string {
  return name.split('#')[0] ?? name
}

// --- Network Device (NetworkDevice) resource — /ers/config/networkdevice ---
//
// Verified against the community pyise-ers ERS client (add_device / get_device
// — github.com/falkowich/pyise-ers, pyiseers/pyiseers.py). A device must belong
// to a Location and a Device Type NDG (ISE's admin UI enforces this too), so
// both default to their "All ..." root when the operator leaves them unset.
export interface NetworkDeviceIp {
  ipaddress: string
  mask: number
}

export interface NetworkDeviceAuthSettings {
  networkProtocol?: 'RADIUS'
  /** ⚠ WRITE-ONLY — see config-types/network-devices' module doc. */
  radiusSharedSecret?: string
  /** ERS wants the literal string "true"/"false", not a JSON boolean. */
  enableKeyWrap?: 'true' | 'false'
}

export interface NetworkDevice {
  id?: string
  name: string
  description?: string
  NetworkDeviceIPList?: NetworkDeviceIp[]
  /** Full "#"-path NDG names this device belongs to, e.g. "Location#All Locations". */
  NetworkDeviceGroupList?: string[]
  authenticationSettings?: NetworkDeviceAuthSettings
  link?: ErsLink
}

// --- Authorization Profile (AuthorizationProfile) resource — /ers/config/authorizationprofile ---
//
// Verified against the official Cisco ISE Ansible collection
// (github.com/CiscoISE/ansible-ise, plugins/modules/authorization_profile.py),
// whose modules are generated from Cisco's own ERS/OpenAPI definitions. Fields
// below are the well-established "standard" (SWITCH) subset this app manages —
// see config-types/authorization-profiles' module doc for what is scoped out.
export interface AuthorizationProfileVlan {
  /** VLAN name or numeric id ISE assigns via RADIUS Tunnel-Private-Group-ID. */
  nameID: string
  /** RADIUS tunnel tag (RFC 2868), 0-31. ISE's UI defaults this to 1. */
  tagID?: number
}

export interface AuthorizationProfileAdvancedAttribute {
  /** A RADIUS/vendor dictionary attribute, e.g. "Radius:Session-Timeout" or "Cisco:cisco-av-pair". */
  leftHandSideDictionaryAttribute?: string
  rightHandSideAttributeValue?: string
}

export interface AuthorizationProfile {
  id?: string
  name: string
  description?: string
  accessType?: 'ACCESS_ACCEPT' | 'ACCESS_REJECT'
  /** Hardcoded to "SWITCH" by this app — see the drop note in the module doc. */
  authzProfileType?: 'SWITCH' | 'TRUSTSEC' | 'TACACS'
  /** Filter-Id ACL name (pre-configured on the network device), independent of a DACL. */
  acl?: string
  /** ISE Downloadable ACL (DACL) name. */
  daclName?: string
  vlan?: AuthorizationProfileVlan
  airespaceACL?: string
  advancedAttributes?: AuthorizationProfileAdvancedAttribute[]
  link?: ErsLink
}
