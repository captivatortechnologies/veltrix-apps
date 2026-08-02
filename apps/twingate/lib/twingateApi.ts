// =============================================================================
// Twingate (ZTNA) GraphQL API client.
//
// Auth is a single static API key sent as a custom header on every request —
// there is no token exchange:
//
//   X-API-KEY: <key>
//
// Generated in the Twingate Admin Console under Settings > API > Generate
// Token. Source: https://www.twingate.com/docs/api-overview ("API
// Authentication" — "You must include X-API-KEY set to your generated API
// token value").
//
// The API itself is GraphQL: one endpoint per network —
//   POST https://<network>.twingate.com/api/graphql/
// with a JSON body { query, variables }. Responses carry the standard GraphQL
// envelope { data, errors }. Source: same page ("API Overview" — endpoint URL
// pattern `https://subdomain.twingate.com/api/graphql/`).
//
// Twingate additionally rate-limits by request kind — 60 reads and 20 writes
// per minute by default — returning HTTP 429 when exceeded (same source,
// "Rate Limiting"). This client retries a 429 with a short fixed backoff.
//
// Many Twingate mutations (resourceCreate, resourceUpdate, resourceDelete, …)
// return a payload shaped `{ ok: Boolean!, error: String, entity: … }` — a
// request can be transport-successful (HTTP 200, no GraphQL `errors[]`) yet
// still fail at the business level with `ok: false`. Confirmed via the
// terraform-provider-twingate `OkError` struct (internal/client/query/common.go)
// embedded by every resource mutation. `mutationOkError()` extracts this so
// callers can fail correctly on both transport AND business-level errors.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status. Every parse / GraphQL-result
// helper returns a NON-UNION { value, error } (or a fully-populated record) so
// callers narrow without help from the compiler or the platform's handler
// loader.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000
const TWINGATE_HOST_SUFFIX = '.twingate.com'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Settings ----------------------------------------------------------------

export interface TwingateSettings {
  timeoutMs: number
}

export function readTwingateSettings(settings: Record<string, unknown>): TwingateSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

// --- Credentials -------------------------------------------------------------

export interface TwingateCredentials {
  apiKey: string
}

/**
 * Extract the Twingate API key from a Veltrix credential. Twingate's API key
 * is a single bearer secret (no paired account id), so it is read from
 * `apiToken` (falling back to `password` for a connection saved under
 * password auth) — `username`, when present, is only an optional label.
 */
export function resolveTwingateCredentials(credential: CredentialRef | null): TwingateCredentials | null {
  if (!credential) return null
  const apiKey = (credential.apiToken ?? credential.password ?? '').trim()
  if (!apiKey) return null
  return { apiKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Twingate API key — generate one in the Twingate Admin Console (Settings > API > Generate Token) ' +
  'and store it in the connection\'s "API token" field.'

export const MISSING_ENDPOINT_MESSAGE =
  'No Twingate network configured — register a "twingate-network" component (or Connection) whose ' +
  'hostname is your Twingate network name, e.g. "acme" or "acme.twingate.com".'

// --- GraphQL transport -------------------------------------------------------

export interface GraphQLError {
  message?: string
  path?: Array<string | number>
  extensions?: { code?: string } & Record<string, unknown>
}

/**
 * The outcome of a GraphQL call. NON-UNION: every field is always present so a
 * handler reads `.transportError` / `.errors` / `.data` without control-flow
 * narrowing (the platform's handler loader does not narrow discriminated
 * unions).
 *   - `transportError` is non-null for a network failure, a timeout, or a
 *     non-2xx HTTP status (the request never produced a GraphQL result).
 *   - `errors` is the GraphQL `errors[]` (query executed but reported
 *     problems — e.g. a malformed query or an invalid API key).
 *   - `data` is the parsed `data` payload (may be present alongside `errors`).
 * NOTE: a mutation can still fail at the business level (`{ ok: false, error }`)
 * with neither of the above set — see `mutationOkError()`.
 */
export interface TwingateGraphQLResponse<T = unknown> {
  status: number
  data: T | null
  errors: GraphQLError[] | null
  transportError: string | null
}

/** A Relay-style connection edge/node/pageInfo envelope, as Twingate returns it. */
export interface TwingateConnection<TNode> {
  edges?: Array<{ node?: TNode | null } | null> | null
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null
  totalCount?: number
}

/** The `{ ok, error }` payload shape shared by Twingate's resource mutations. */
export interface OkErrorPayload {
  ok?: boolean
  error?: string | null
}

export class TwingateClient {
  private readonly graphqlUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: { graphqlUrl: string; apiKey: string; timeoutMs: number }) {
    this.graphqlUrl = opts.graphqlUrl
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
  }

  get endpoint(): string {
    return this.graphqlUrl
  }

  /**
   * Execute a GraphQL operation. POSTs `{ query, variables }` with the
   * `X-API-KEY` header, retries a 429 with backoff, and returns a non-union
   * response. Never throws on an HTTP error status.
   */
  async graphql<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<TwingateGraphQLResponse<T>> {
    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(this.graphqlUrl, {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey,
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
          return { status: res.status, data: null, errors: null, transportError: 'Twingate returned a non-JSON response' }
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
   * Page through a Relay-style connection (`edges { node } pageInfo`),
   * concatenating nodes. `connectionField` is the root field name (e.g.
   * `resources`, `remoteNetworks`, `groups`). Returns a non-union result.
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
      const res: TwingateGraphQLResponse<Record<string, TwingateConnection<TNode>>> = await this.graphql(query, {
        first: pageSize,
        after,
      })
      if (res.transportError) return { nodes, error: res.transportError }
      if (res.errors) return { nodes, error: graphqlErrorMessage(res.errors) }
      const connection = res.data?.[connectionField]
      if (!connection) return { nodes, error: `Twingate response is missing the "${connectionField}" field` }
      for (const edge of connection.edges ?? []) {
        if (edge?.node) nodes.push(edge.node)
      }
      if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break
      after = connection.pageInfo.endCursor
    }
    return { nodes, error: null }
  }
}

// --- Client construction -----------------------------------------------------

/**
 * Reduce a hostname to a bare Twingate network host: strips protocol, path and
 * port, and appends the `.twingate.com` suffix when the operator entered just
 * the network name (e.g. "acme" → "acme.twingate.com"). A host already ending
 * in `.twingate.com` is left as-is.
 */
export function normalizeNetworkHost(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim().toLowerCase()
  if (!host) return null
  host = host
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
  if (!host) return null
  if (!host.endsWith(TWINGATE_HOST_SUFFIX)) host = `${host}${TWINGATE_HOST_SUFFIX}`
  return host
}

/** Build a client from a component hostname (the network name/host), a credential and settings. */
export function buildTwingateClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: TwingateClient; graphqlUrl: string; networkHost: string } | { error: string } {
  const creds = resolveTwingateCredentials(credential)
  if (!creds) return { error: MISSING_CREDENTIAL_MESSAGE }

  const networkHost = normalizeNetworkHost(hostname)
  if (!networkHost) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readTwingateSettings(settings)
  const graphqlUrl = `https://${networkHost}/api/graphql/`

  return {
    client: new TwingateClient({ graphqlUrl, apiKey: creds.apiKey, timeoutMs: resolved.timeoutMs }),
    graphqlUrl,
    networkHost,
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
export function responseError(res: TwingateGraphQLResponse): string | null {
  if (res.transportError) return res.transportError
  if (res.errors) return graphqlErrorMessage(res.errors)
  return null
}

/**
 * Extract the business-level failure from a Twingate mutation's `{ ok, error }`
 * payload. Returns null when the payload is missing (transport/GraphQL-level
 * failure — check `responseError` instead) or reports success.
 */
export function mutationOkError(payload: OkErrorPayload | null | undefined): string | null {
  if (!payload) return null
  if (payload.ok === false) return payload.error?.trim() || 'Twingate rejected the request (ok: false)'
  return null
}

/** Trim an HTTP error body to a short single line for messages. */
function httpBodySummary(body: string): string {
  const trimmed = (body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return 'no response body'
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed
}
