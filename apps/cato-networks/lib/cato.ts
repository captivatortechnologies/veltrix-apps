// =============================================================================
// Cato Networks - Cato Management Application (CMA) API client.
//
// The CMA API is a SINGLE GraphQL endpoint, global (not per-tenant/region):
//
//   POST https://api.catonetworks.com/api/v1/graphql2
//
// Auth is a Cato API Key (Administration > API Keys in the Cato Management
// Application), sent as `x-api-key`. Every operation is additionally scoped to
// a tenant by account id, sent BOTH as the `x-account-id` header AND as the
// `accountId` GraphQL argument on the query/mutation root field being called
// (e.g. `policy(accountId: ID!)`, `object(accountId: ID!)`) - confirmed against
// Cato's own generated Go SDK (github.com/catonetworks/cato-go-sdk, client.go /
// cato.go: `req.Header.Set("x-api-key", token)`, `req.Header.Set("x-account-id",
// accountId)`), which is built directly from Cato's own GraphQL schema
// (cato_api.graphqls in that repo - the same schema that documents
// api.catonetworks.com/documentation/).
//
// The account id is stored as this app's `cato-account` component hostname.
//
// NOTE: a handful of TOP-LEVEL query fields unrelated to this app (accountSnapshot,
// admins, entityLookup, ...) take `accountID` (capital ID) instead of `accountId` -
// a real inconsistency in Cato's own schema. Every field this app calls -
// `policy`, `object`, `customAppData` - uses the lowercase-d `accountId` spelling;
// verified directly against cato_api.graphqls.
//
// Rate limiting: Cato returns HTTP 429 (or a GraphQL-level "rate limit" error
// string) under load; the Go SDK retries with backoff. This client does the same
// for a bounded number of attempts.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_API_URL = 'https://api.catonetworks.com/api/v1/graphql2'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_BACKOFF_MS = 3_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- Settings ----------------------------------------------------------------

export interface CatoSettings {
  apiUrl: string
  timeoutMs: number
}

export function readCatoSettings(settings: Record<string, unknown>): CatoSettings {
  const rawUrl = settings.api_base_url
  const apiUrl = typeof rawUrl === 'string' && /^https:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : DEFAULT_API_URL

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { apiUrl, timeoutMs }
}

// --- Credentials ---------------------------------------------------------------

/** Extract the Cato API key from a Veltrix credential (stored as the "API token" field). */
export function resolveCatoApiKey(credential: CredentialRef | null): string | null {
  const key = (credential?.apiToken ?? '').trim()
  return key.length > 0 ? key : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Cato API key - create one in the Cato Management Application under Administration > API Keys ' +
  '(scoped to a role covering the objects this app manages), then store it as this connection\'s "API token".'

export const MISSING_ACCOUNT_MESSAGE =
  'No Cato Account ID - register a "cato-account" component whose hostname is your Cato Account ID ' +
  '(shown in the Cato Management Application UI, top-right account switcher, or via Administration > API Keys).'

// --- GraphQL transport ---------------------------------------------------------

export interface GraphQLError {
  message?: string
  path?: Array<string | number>
  extensions?: { code?: string } & Record<string, unknown>
}

/**
 * The outcome of a GraphQL call. NON-UNION: every field is always present so a
 * handler reads `.transportError` / `.errors` / `.data` without control-flow
 * narrowing (the platform's handler loader does not narrow discriminated unions).
 */
export interface CatoGraphQLResponse<T = unknown> {
  status: number
  data: T | null
  errors: GraphQLError[] | null
  transportError: string | null
}

function isRateLimited(status: number, errors: GraphQLError[] | null): boolean {
  if (status === 429) return true
  if (!errors) return false
  return errors.some((e) => /rate[\s-]?limit/i.test(e.message ?? ''))
}

export class CatoClient {
  private readonly apiUrl: string
  private readonly apiKey: string
  readonly accountId: string
  private readonly timeoutMs: number

  constructor(opts: { apiUrl: string; apiKey: string; accountId: string; timeoutMs: number }) {
    this.apiUrl = opts.apiUrl
    this.apiKey = opts.apiKey
    this.accountId = opts.accountId
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * Execute one GraphQL operation. Sends `x-api-key` + `x-account-id`, retries a
   * 429 (or a GraphQL "rate limit" error) with backoff, and never throws on an
   * HTTP error status - callers read `.transportError` / `.errors`.
   */
  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<CatoGraphQLResponse<T>> {
    let attempts = 0
    while (true) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(this.apiUrl, {
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'x-account-id': this.accountId,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        })
        const text = await res.text()
        const parsed = parseJson<{ data?: T; errors?: GraphQLError[] }>(text)

        const errors = parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0 ? parsed.errors : null

        if (isRateLimited(res.status, errors) && attempts < MAX_RATE_LIMIT_RETRIES) {
          attempts++
          clearTimeout(timer)
          await sleep(RATE_LIMIT_BACKOFF_MS * attempts)
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
        if (!parsed) {
          return { status: res.status, data: null, errors: null, transportError: 'Cato returned a non-JSON response' }
        }
        return { status: res.status, data: parsed.data ?? null, errors, transportError: null }
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
}

/** Build a client from a component hostname (the Cato Account ID), a credential and settings. */
export function buildCatoClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: CatoClient; accountId: string } | { error: string } {
  const apiKey = resolveCatoApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }

  const accountId = (hostname ?? '').trim()
  if (!accountId) return { error: MISSING_ACCOUNT_MESSAGE }

  const resolved = readCatoSettings(settings)
  return {
    client: new CatoClient({ apiUrl: resolved.apiUrl, apiKey, accountId, timeoutMs: resolved.timeoutMs }),
    accountId,
  }
}

// --- Shared helpers ------------------------------------------------------------

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
export function responseError(res: CatoGraphQLResponse): string | null {
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

/**
 * Build a Cato "RefInput" ({ by: ID|NAME, input: <value> }) - the generic
 * reference shape used pervasively across the CMA schema (SiteRefInput,
 * CustomCategoryRefInput, ApplicationCategoryRefInput, GlobalIpRangeRefInput,
 * HostRefInput, ...). Values that look like a Cato internal id (numeric, or a
 * UUID) are referenced `by: ID`; everything else is referenced `by: NAME` -
 * letting canvas authors write human-readable object names, matching how
 * Cato's own Terraform provider accepts name-based refs.
 */
export function buildRef(value: string): { by: 'ID' | 'NAME'; input: string } {
  const trimmed = value.trim()
  const looksLikeId = /^\d+$/.test(trimmed) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)
  return { by: looksLikeId ? 'ID' : 'NAME', input: trimmed }
}
