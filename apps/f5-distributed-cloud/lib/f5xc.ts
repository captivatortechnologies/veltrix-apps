// =============================================================================
// F5 Distributed Cloud (XC) public config API client for the
// f5-distributed-cloud app.
//
// Auth: an F5 XC "API Token" credential (Console > Administration > Personal
//   Management > Credentials > Add Credentials > API Token). Sent as a plain
//   bearer-style header on every request - no token exchange, no expiry to
//   manage:
//     Authorization: APIToken <token>
//   Confirmed verbatim against F5's own generated Terraform provider docs:
//   https://github.com/volterraedge/terraform-provider-volterra/blob/master/docs/resources/volterra_api_credential.md
//   ("API token - an easy to use secret that can be send part of HTTP request
//   header Authorization: APIToken") and https://docs.cloud.f5.com/docs/api/api-credential
//
// Base URL: https://<tenant>.console.ves.volterra.io/api - confirmed from the
//   provider's own README (`url = "https://<tenant_name>.console.ves.volterra.io/api"`,
//   https://github.com/volterraedge/terraform-provider-volterra#readme).
//
// Every config object lives under one CRUD surface:
//   GET/POST      /config/namespaces/{namespace}/{objectPlural}
//   GET/PUT/DELETE /config/namespaces/{namespace}/{objectPlural}/{name}
// A namespace is a tenant-internal partition (e.g. "default", "staging") -
// this app manages ONE namespace per connection (the `f5xc_namespace` app
// setting), the same "one target scope per connection" convention
// ping-identity/okta-identity use for environment/org.
//
// Object-plural URL segments are confirmed from the decompiled grpc-gateway
// route literals in F5's own terraform-provider-volterra
// (pbgo/extschema/schema/**/public_crudapi.pb.gw.go) rather than assumed -
// several are irregular (simple "+s" suffixing, not English pluralization):
//   service_policy -> service_policys (NOT "service_policies")
//   network_policy -> network_policys (NOT "network_policies")
// See each config type's validate.ts header comment for its exact citation.
//
// Every object shares the same envelope (ves.io schema convention, confirmed
// from pbgo/extschema/schema/views/origin_pool/public_crudapi.pb.go):
//   GET  -> { metadata, system_metadata, spec, resource_version, ... }
//   POST/PUT body -> { metadata, spec }  (system_metadata is server-managed)
//   LIST -> { items: [{ name, namespace, uid, description, disabled, labels, ... }] }
//           (list items carry NO spec unless report_fields is requested - a
//           Get call is required to read/replay an existing object's spec)
//
// request() never throws on an HTTP error status - callers inspect `status` so
// they can tell a 404 (object absent) from a real failure, mirroring every
// other app's client in this repo (see lib/pingOne.ts, lib/okta.ts).
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_NAMESPACE = 'default'
const CONSOLE_SUFFIX = '.console.ves.volterra.io'

// --- Settings -----------------------------------------------------------------

export interface F5xcSettings {
  namespace: string
  timeoutMs: number
}

/** Read and normalize the app settings that drive F5 XC API access. */
export function readF5xcSettings(settings: Record<string, unknown>): F5xcSettings {
  const rawNamespace = settings.f5xc_namespace
  const namespace =
    typeof rawNamespace === 'string' && rawNamespace.trim() ? rawNamespace.trim() : DEFAULT_NAMESPACE

  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30

  return { namespace, timeoutMs: timeoutSeconds * 1000 }
}

// --- Credentials ---------------------------------------------------------------

export interface F5xcCredentials {
  apiToken: string
}

/**
 * Extract the F5 XC API Token from a Veltrix credential. Convention: the
 * token lives in the credential's "API token" field (username is unused -
 * an API Token credential is a single bearer secret, not a client id/secret
 * pair).
 */
export function resolveF5xcCredentials(credential: CredentialRef | null): F5xcCredentials | null {
  if (!credential) return null
  const apiToken = (credential.apiToken ?? credential.password ?? '').trim()
  if (!apiToken) return null
  return { apiToken }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No F5 Distributed Cloud API Token credential available - store the token in the credential ' +
  '"API token" field. Create one under Console > Administration > Personal Management > ' +
  'Credentials > Add Credentials, with API Credential Type "API Token".'

/**
 * Extract the F5 XC tenant console hostname from a connection. Convention
 * (mirrors okta-identity's org-domain-as-hostname): stored as the deploy
 * target component's hostname. Accepts a bare tenant subdomain ("acmecorp"),
 * a full console hostname ("acmecorp.console.ves.volterra.io"), or a full URL
 * (with or without a trailing "/api") - all normalize to the same tenant host.
 */
export function resolveTenantHost(hostname: string | null | undefined): string | null {
  let value = hostname?.trim()
  if (!value) return null
  value = value.replace(/^https?:\/\//i, '').replace(/\/api\/?$/i, '').replace(/\/+$/, '')
  if (!value) return null
  if (!value.includes('.')) value = `${value}${CONSOLE_SUFFIX}`
  return value
}

export const MISSING_TENANT_MESSAGE =
  'No F5 Distributed Cloud tenant is registered for this connection yet - set the connection\'s ' +
  'endpoint to your tenant console hostname (e.g. "acmecorp.console.ves.volterra.io", found in the ' +
  'browser address bar when logged into the F5 XC Console), and save the connection.'

// --- HTTP client ----------------------------------------------------------------

export interface F5xcResponse {
  status: number
  ok: boolean
  body: string
}

/** Standard grpc-gateway JSON error envelope every F5 XC public API returns on failure. */
export interface F5xcErrorEnvelope {
  code?: number
  message?: string
  details?: Array<Record<string, unknown>>
}

export type F5xcMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * Metadata shape shared by every F5 XC object's create/replace request body.
 * Carries an index signature so a live GET's metadata (which includes
 * additional server-managed fields this app does not model, e.g. uid, tenant,
 * creation_timestamp) can be narrowed to this shape without a cast.
 */
export interface F5xcObjectMetadata {
  name: string
  namespace?: string
  description?: string
  disable?: boolean
  labels?: Record<string, string>
  annotations?: Record<string, string>
  [key: string]: unknown
}

/** GET .../{objectPlural}/{name} response envelope (ves.io schema convention). */
export interface F5xcGetResponse<TSpec = Record<string, unknown>> {
  metadata?: F5xcObjectMetadata & { uid?: string }
  system_metadata?: Record<string, unknown>
  spec?: TSpec
  resource_version?: string
}

/** One row of a LIST .../{objectPlural} response - metadata only, no spec. */
export interface F5xcListItem {
  name?: string
  namespace?: string
  uid?: string
  description?: string
  disabled?: boolean
  labels?: Record<string, string>
  [key: string]: unknown
}

export interface F5xcListResponse {
  items?: F5xcListItem[]
  errors?: Array<Record<string, unknown>>
}

export class F5xcClient {
  private readonly baseUrl: string
  private readonly apiToken: string
  private readonly timeoutMs: number

  constructor(opts: { tenantHost: string; namespace: string; credentials: F5xcCredentials; timeoutMs: number }) {
    this.baseUrl = `https://${opts.tenantHost}/api/config/namespaces/${encodeURIComponent(opts.namespace)}`
    this.apiToken = opts.credentials.apiToken
    this.timeoutMs = opts.timeoutMs
  }

  /** List every object of a plural type in the connection's namespace (metadata only, no spec). */
  async list(objectPlural: string): Promise<{ ok: boolean; items: F5xcListItem[]; status: number; body: string }> {
    const res = await this.request('GET', `/${objectPlural}`)
    if (!res.ok) return { ok: false, items: [], status: res.status, body: res.body }
    const parsed = parseJson<F5xcListResponse>(res.body)
    return { ok: true, items: parsed?.items ?? [], status: res.status, body: res.body }
  }

  /** Fetch one object's full metadata + spec by name; null on 404. */
  async get<TSpec = Record<string, unknown>>(
    objectPlural: string,
    name: string,
  ): Promise<F5xcGetResponse<TSpec> | null> {
    const res = await this.request('GET', `/${objectPlural}/${encodeURIComponent(name)}`)
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`Failed to fetch ${objectPlural}/${name}: ${f5xcErrorMessage(res)}`)
    }
    return parseJson<F5xcGetResponse<TSpec>>(res.body)
  }

  /** POST .../{objectPlural} - create a new object. Body is { metadata, spec }. */
  async create(objectPlural: string, body: { metadata: F5xcObjectMetadata; spec: unknown }): Promise<F5xcResponse> {
    return this.request('POST', `/${objectPlural}`, { body })
  }

  /** PUT .../{objectPlural}/{name} - replace an existing object in place. Body is { metadata, spec }. */
  async replace(
    objectPlural: string,
    name: string,
    body: { metadata: F5xcObjectMetadata; spec: unknown },
  ): Promise<F5xcResponse> {
    return this.request('PUT', `/${objectPlural}/${encodeURIComponent(name)}`, { body })
  }

  /** DELETE .../{objectPlural}/{name}. A 404 is treated as already-absent by callers, not surfaced here. */
  async remove(objectPlural: string, name: string): Promise<F5xcResponse> {
    return this.request('DELETE', `/${objectPlural}/${encodeURIComponent(name)}`)
  }

  /** Low-level request against the namespace-scoped base URL. Never throws on an HTTP error status. */
  async request(method: F5xcMethod, path: string, opts: { body?: unknown } = {}): Promise<F5xcResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `APIToken ${this.apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Build an F5xcClient from a component hostname (the tenant console host), a
 * credential (the API Token) and app settings (namespace, timeout). Returns a
 * descriptive `error` instead of throwing so every handler can surface one
 * consistent message.
 */
export function buildF5xcClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: F5xcClient; tenantHost: string; namespace: string } | { error: string } {
  const credentials = resolveF5xcCredentials(credential)
  if (!credentials) return { error: MISSING_CREDENTIAL_MESSAGE }

  const tenantHost = resolveTenantHost(hostname)
  if (!tenantHost) return { error: MISSING_TENANT_MESSAGE }

  const resolved = readF5xcSettings(settings)
  return {
    client: new F5xcClient({ tenantHost, namespace: resolved.namespace, credentials, timeoutMs: resolved.timeoutMs }),
    tenantHost,
    namespace: resolved.namespace,
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from an F5 XC error response body (standard grpc-gateway envelope). */
export function f5xcErrorMessage(res: F5xcResponse): string {
  const parsed = parseJson<F5xcErrorEnvelope>(res.body)
  if (parsed?.message) return parsed.message
  return res.body || `HTTP ${res.status}`
}

/** Strip undefined/blank-optional keys so a request body only carries fields the canvas actually set. */
export function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value
  }
  return out
}

/** Deterministic JSON stringify with recursively sorted object keys - for drift comparisons. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed items. */
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

/** A ves.io "ref" to another named object in the same (or another) namespace/tenant. */
export interface F5xcRef {
  name: string
  namespace?: string
  tenant?: string
}

/** Build a ref body from a plain name, defaulting to the current namespace. */
export function toRef(name: string, namespace?: string): F5xcRef {
  return namespace ? { name, namespace } : { name }
}
