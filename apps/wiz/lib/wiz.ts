// =============================================================================
// Wiz (CNAPP / cloud security) API client.
//
// Auth is OAuth2 client credentials. A Wiz service account's Client ID + Client
// Secret (from a Veltrix credential) are exchanged for a bearer token at the
// tenant's auth endpoint:
//
//   POST https://auth.app.wiz.io/oauth/token        (current — Cognito backend)
//        grant_type=client_credentials&client_id=…&client_secret=…&audience=wiz-api
//   POST https://auth.wiz.io/oauth/token            (legacy  — Auth0 backend)
//        …&audience=beyond-api
//
// The token (~1h) is cached and reused. The audience is derived from the auth
// endpoint host so older (auth.wiz.io) tenants work without extra configuration.
//
// The API itself is GraphQL: a single endpoint per tenant/region —
//   POST https://api.<region>.app.wiz.io/graphql   (the component hostname)
// with a JSON body { query, variables } and a Bearer token. Responses carry the
// standard GraphQL envelope { data, errors }.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout,
// never throws on an HTTP error status, and honors 429 with backoff. Every
// parse / auth / GraphQL-result helper returns a NON-UNION { value, error } (or
// a fully-populated record) so callers narrow without help from the compiler or
// the platform's handler loader.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000
const TOKEN_EXPIRY_BUFFER_MS = 60_000

export const DEFAULT_AUTH_ENDPOINT = 'https://auth.app.wiz.io/oauth/token'
/** The audience for the modern (Cognito) auth backend. */
const AUDIENCE_MODERN = 'wiz-api'
/** The audience for the legacy (Auth0) auth backend at auth.wiz.io. */
const AUDIENCE_LEGACY = 'beyond-api'
const LEGACY_AUTH_HOSTS = new Set(['auth.wiz.io'])

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Settings ----------------------------------------------------------------

export interface WizSettings {
  authEndpoint: string
  audience: string
  timeoutMs: number
}

/** Derive the OAuth audience from an auth endpoint host (legacy vs modern). */
export function audienceForAuthEndpoint(authEndpoint: string): string {
  try {
    const host = new URL(authEndpoint).hostname.toLowerCase()
    return LEGACY_AUTH_HOSTS.has(host) ? AUDIENCE_LEGACY : AUDIENCE_MODERN
  } catch {
    return AUDIENCE_MODERN
  }
}

export function readWizSettings(settings: Record<string, unknown>): WizSettings {
  const rawEndpoint = settings.auth_endpoint
  const authEndpoint =
    typeof rawEndpoint === 'string' && /^https:\/\//i.test(rawEndpoint.trim())
      ? rawEndpoint.trim()
      : DEFAULT_AUTH_ENDPOINT

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { authEndpoint, audience: audienceForAuthEndpoint(authEndpoint), timeoutMs }
}

// --- Credentials -------------------------------------------------------------

export interface WizCredentials {
  clientId: string
  clientSecret: string
}

/**
 * Extract the Wiz service-account credentials from a Veltrix credential:
 * Client ID in `username`, Client Secret in `apiToken` (or `password`).
 */
export function resolveWizCredentials(credential: CredentialRef | null): WizCredentials | null {
  if (!credential) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Wiz service-account credential — create a service account in Wiz (Settings > Service Accounts) ' +
  'with the API scopes this app needs, then store its Client ID in the credential "username" field and ' +
  'its Client Secret in the "API token" field.'

export const MISSING_ENDPOINT_MESSAGE =
  'No Wiz API endpoint — register a "wiz-tenant" component whose hostname is your regional Wiz API ' +
  'host (find it in Wiz under Settings > Tenant, e.g. api.us17.app.wiz.io).'

// --- GraphQL transport -------------------------------------------------------

export interface GraphQLError {
  message?: string
  path?: Array<string | number>
  extensions?: { code?: string } & Record<string, unknown>
}

/**
 * The outcome of a GraphQL call. NON-UNION: every field is always present so a
 * handler reads `.transportError` / `.errors` / `.data` without control-flow
 * narrowing (the platform's handler loader does not narrow discriminated unions).
 *   - `transportError` is non-null for a network failure, a timeout, an auth
 *     failure, or a non-2xx HTTP status (the request never produced a GraphQL
 *     result).
 *   - `errors` is the GraphQL `errors[]` (query executed but reported problems).
 *   - `data` is the parsed `data` payload (may be present alongside `errors`).
 */
export interface WizGraphQLResponse<T = unknown> {
  status: number
  data: T | null
  errors: GraphQLError[] | null
  transportError: string | null
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

export class WizClient {
  private readonly graphqlUrl: string
  private readonly tokenUrl: string
  private readonly audience: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly timeoutMs: number
  private cachedToken: CachedToken | null = null

  constructor(opts: {
    graphqlUrl: string
    tokenUrl: string
    audience: string
    creds: WizCredentials
    timeoutMs: number
  }) {
    this.graphqlUrl = opts.graphqlUrl
    this.tokenUrl = opts.tokenUrl
    this.audience = opts.audience
    this.clientId = opts.creds.clientId
    this.clientSecret = opts.creds.clientSecret
    this.timeoutMs = opts.timeoutMs
  }

  get endpoint(): string {
    return this.graphqlUrl
  }

  /**
   * Execute a GraphQL operation. Acquires (and caches) a bearer token, POSTs
   * `{ query, variables }`, retries a 429 with backoff, and returns a non-union
   * response. Never throws on an HTTP error status.
   */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<WizGraphQLResponse<T>> {
    const auth = await this.acquireToken()
    if (!auth.token) {
      return { status: 0, data: null, errors: null, transportError: auth.error ?? 'authentication failed' }
    }

    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(this.graphqlUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        })
        const text = await res.text()

        if (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
          attempts++
          clearTimeout(timer)
          await sleep(RATE_LIMIT_BACKOFF_MS)
          continue
        }

        if (res.status < 200 || res.status >= 300) {
          return {
            status: res.status,
            data: null,
            errors: null,
            transportError: `HTTP ${res.status}: ${httpBodySummary(text)}`,
          }
        }

        const parsed = parseJson<{ data?: T; errors?: GraphQLError[] }>(text)
        if (!parsed) {
          return { status: res.status, data: null, errors: null, transportError: 'Wiz returned a non-JSON response' }
        }
        return {
          status: res.status,
          data: parsed.data ?? null,
          errors: Array.isArray(parsed.errors) && parsed.errors.length > 0 ? parsed.errors : null,
          transportError: null,
        }
      } catch (err) {
        return {
          status: 0,
          data: null,
          errors: null,
          transportError: err instanceof Error ? err.message : 'GraphQL request failed',
        }
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /**
   * Page through a Relay-style connection, concatenating `nodes`. `connectionField`
   * is the root field name (e.g. `serviceAccounts`). Returns a non-union result.
   */
  async listConnection<TNode = unknown>(
    query: string,
    connectionField: string,
    pageSize: number,
    maxPages = 100,
  ): Promise<{ nodes: TNode[]; error: string | null }> {
    const nodes: TNode[] = []
    let after: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const res: WizGraphQLResponse<Record<string, WizConnection<TNode>>> = await this.graphql(query, {
        first: pageSize,
        after,
      })
      if (res.transportError) return { nodes, error: res.transportError }
      if (res.errors) return { nodes, error: graphqlErrorMessage(res.errors) }
      const connection: WizConnection<TNode> | undefined = res.data?.[connectionField]
      if (!connection) return { nodes, error: `Wiz response is missing the "${connectionField}" field` }
      if (Array.isArray(connection.nodes)) nodes.push(...connection.nodes)
      if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break
      after = connection.pageInfo.endCursor
    }
    return { nodes, error: null }
  }

  /** Acquire (and cache) an OAuth2 client-credentials bearer token. NON-UNION result. */
  private async acquireToken(): Promise<{ token: string | null; error: string | null }> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > Date.now()) {
      return { token: this.cachedToken.token, error: null }
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      audience: this.audience,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: controller.signal,
      })
      const text = await res.text()
      const parsed = parseJson<{
        access_token?: string
        expires_in?: number
        error?: string
        error_description?: string
      }>(text)
      if (res.status < 200 || res.status >= 300 || !parsed?.access_token) {
        const reason = parsed?.error_description || parsed?.error || `HTTP ${res.status}`
        return { token: null, error: `Wiz token request failed: ${reason}` }
      }
      const ttlMs = (typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600) * 1000
      this.cachedToken = { token: parsed.access_token, expiresAtMs: Date.now() + ttlMs - TOKEN_EXPIRY_BUFFER_MS }
      return { token: parsed.access_token, error: null }
    } catch (err) {
      return { token: null, error: err instanceof Error ? err.message : 'Wiz token request failed' }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Relay connection envelope returned by Wiz list queries. */
export interface WizConnection<TNode> {
  nodes?: TNode[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  totalCount?: number
}

// --- Client construction -----------------------------------------------------

/** Reduce a hostname to a bare Wiz API host: strips protocol, path (incl. /graphql) and port. */
export function normalizeApiHost(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim().toLowerCase()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
  return host.length > 0 ? host : null
}

/** Build a client from a component hostname (the API host), a credential and settings. */
export function buildWizClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: WizClient; graphqlUrl: string; apiHost: string } | { error: string } {
  const creds = resolveWizCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const apiHost = normalizeApiHost(hostname)
  if (!apiHost) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readWizSettings(settings)
  const graphqlUrl = `https://${apiHost}/graphql`

  return {
    client: new WizClient({
      graphqlUrl,
      tokenUrl: resolved.authEndpoint,
      audience: resolved.audience,
      creds,
      timeoutMs: resolved.timeoutMs,
    }),
    graphqlUrl,
    apiHost,
  }
}

// --- Shared helpers ----------------------------------------------------------

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Join a GraphQL `errors[]` into one human-readable message. */
export function graphqlErrorMessage(errors: GraphQLError[] | null): string {
  if (!errors || errors.length === 0) return 'unknown GraphQL error'
  return errors.map((e) => e.message || e.extensions?.code || 'error').join('; ')
}

/** A single, combined error string for a GraphQL response (transport or GraphQL-level), or null. */
export function responseError(res: WizGraphQLResponse): string | null {
  if (res.transportError) return res.transportError
  if (res.errors) return graphqlErrorMessage(res.errors)
  return null
}

/** Trim an HTTP error body to a short single line for messages. */
function httpBodySummary(body: string): string {
  const trimmed = (body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return 'no response body'
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed
}
