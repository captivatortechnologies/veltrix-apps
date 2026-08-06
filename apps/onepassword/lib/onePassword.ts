// =============================================================================
// 1Password SCIM Bridge client for the onepassword app.
//
// 1Password's public write surface is heavily secret-oriented: the Connect
// API reads/writes vault ITEMS (login/password/API-credential secrets) and
// only LISTS vaults (no create/update - developer.1password.com/connect/
// api-reference has no POST or PATCH under /v1/vaults); the Events API is
// read-only (GET /api/audit/v1/logs). Neither is a config-as-code surface.
//
// The genuine, non-secret, declarative surface this app manages instead is
// identity/access governance through the self-hosted 1Password SCIM Bridge -
// the same integration point 1Password's supported identity providers
// (Google Workspace, JumpCloud, Microsoft Entra ID, Okta, OneLogin, Rippling)
// use to provision users and manage the Groups that grant/revoke vault
// access (support.1password.com/scim/). This client speaks to that bridge
// directly, as a generic SCIM 2.0 client would.
//
// Auth: a bearer token minted for the bridge's identity-provider integration
//   (the `scimsession` credential, created once during setup) - sent as
//   `Authorization: Bearer <token>` on every request. Verified directly
//   against a live example in 1Password's own deployment repo:
//     github.com/1Password/scim-examples, kubernetes/README.md ("Step 5:
//     Test your SCIM bridge") -
//       curl -H "Authorization: Bearer <token>" https://<bridge>/health
//   returning { build, version, reports: [{ source, state, ... }] }.
//
// Base URL: the bridge's bare domain, with NO path suffix (not /scim/v2) -
//   confirmed against TWO independent, still-current IdP setup guides that
//   both instruct the admin to enter the bridge's root domain as the "SCIM
//   connector base URL": support.1password.com/scim-jumpcloud/ ("Enter the
//   URL of your SCIM bridge ... doesn't include a forward slash at the end.
//   For example: https://scim.example.com") and support.1password.com/
//   scim-onelogin/ (identical wording).
//
// Capabilities, verbatim from 1Password's own deployment guide
//   (github.com/1Password/scim-examples, PREPARATION.md, "Considerations"):
//   "This integration will create, confirm, and suspend users, and create
//   and manage access to groups." No delete endpoint is documented for
//   either Users or Groups - support.1password.com/scim/ describes account
//   deletion as a manual, permanent action taken on 1Password.com, not a
//   bridge/SCIM operation. This client therefore never issues a DELETE - see
//   README.md Coverage for how rollback and removal are handled instead.
//
// The bridge implements the SCIM 2.0 protocol (IETF RFC 7643 core schema,
// RFC 7644 protocol) that every one of those identity providers speaks to
// it, so this client uses the STANDARD SCIM resource endpoints and message
// schemas rather than anything 1Password-proprietary:
//   GET    /Users            - urn:ietf:params:scim:api:messages:2.0:ListResponse
//   GET    /Users/{id}
//   POST   /Users             - urn:ietf:params:scim:schemas:core:2.0:User
//   PATCH  /Users/{id}        - urn:ietf:params:scim:api:messages:2.0:PatchOp
//   GET    /Groups
//   GET    /Groups/{id}
//   POST   /Groups            - urn:ietf:params:scim:schemas:core:2.0:Group
//   PATCH  /Groups/{id}
// RFC 7644 SS3.1 requires the `application/scim+json` media type on request
// and response bodies - used here on every call, not `application/json`.
//
// Handlers run in-process in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency. request()
// never throws on an HTTP error status - callers inspect `status` so they can
// tell a 404 (resource absent) from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const SCIM_CONTENT_TYPE = 'application/scim+json'
/** RFC 7644 SS3.4.2 - page size used when walking a ListResponse to completion. */
const LIST_PAGE_SIZE = 100

// --- Settings ----------------------------------------------------------------

export interface OnePasswordSettings {
  timeoutMs: number
}

/** Read and normalize the app settings that drive SCIM Bridge access. */
export function readOnePasswordSettings(settings: Record<string, unknown>): OnePasswordSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutSeconds =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 30
  return { timeoutMs: timeoutSeconds * 1000 }
}

// --- Credentials ---------------------------------------------------------------

/**
 * Extract the SCIM Bridge bearer token from a Veltrix credential.
 * Convention (mirrors hashicorp-vault's token-only credential): the token in
 * "API token" (preferred) or "password".
 */
export function resolveOnePasswordToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No 1Password SCIM Bridge bearer token available - store the token generated when the bridge was set ' +
  'up (the same token used for your identity-provider integration) in the credential "API token" field. ' +
  'See support.1password.com/scim/ to provision or recover it.'

export const MISSING_ENDPOINT_MESSAGE =
  'No 1Password SCIM Bridge address is registered for this connection yet - set the connection\'s ' +
  'endpoint to your SCIM Bridge\'s base URL (e.g. "https://scim.example.com" - no trailing slash, no ' +
  '/scim/v2 path), and save the connection.'

// --- HTTP client -----------------------------------------------------------------

export interface OnePasswordResponse {
  status: number
  ok: boolean
  body: string
}

export type OnePasswordMethod = 'GET' | 'POST' | 'PATCH'

export class OnePasswordClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: OnePasswordMethod,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<OnePasswordResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': SCIM_CONTENT_TYPE,
          Accept: SCIM_CONTENT_TYPE,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Walk a SCIM ListResponse (RFC 7644 SS3.4.2) to completion via
   * startIndex/itemsPerPage, returning every `Resources` entry. Stops when a
   * page is empty/short or `totalResults` has been reached.
   */
  async listAll<T = unknown>(
    path: string,
    opts: { filter?: string } = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let startIndex = 1
    let lastStatus = 0
    let lastBody = ''

    for (;;) {
      const res = await this.request('GET', path, {
        query: { filter: opts.filter, startIndex, count: LIST_PAGE_SIZE },
      })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }

      const parsed = parseJson<ScimListResponse<T>>(res.body)
      const page = Array.isArray(parsed?.Resources) ? (parsed!.Resources as T[]) : []
      items.push(...page)

      const totalResults = typeof parsed?.totalResults === 'number' ? parsed!.totalResults : items.length
      if (page.length === 0 || items.length >= totalResults) break
      startIndex += page.length
    }

    return { ok: true, items, status: lastStatus, body: lastBody }
  }
}

export interface ScimListResponse<T> {
  schemas?: string[]
  totalResults?: number
  itemsPerPage?: number
  startIndex?: number
  Resources?: T[]
}

/** A single `Operations[]` entry of a SCIM PatchOp request body (RFC 7644 SS3.5.2). */
export interface ScimPatchOperation {
  op: 'add' | 'remove' | 'replace'
  path?: string
  value?: unknown
}

/** Build a `urn:ietf:params:scim:api:messages:2.0:PatchOp` request body. */
export function buildPatchOp(operations: ScimPatchOperation[]): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: operations,
  }
}

/**
 * Build a client from a component hostname (the SCIM Bridge's base URL), a
 * credential (bearer token) and app settings (timeout). Returns a
 * descriptive `error` instead of throwing so every handler surfaces one
 * consistent message.
 */
export function buildOnePasswordClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: OnePasswordClient; baseUrl: string } | { error: string } {
  const token = resolveOnePasswordToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = hostname?.trim()
  if (!host) return { error: MISSING_ENDPOINT_MESSAGE }

  const baseUrl = host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`
  const resolved = readOnePasswordSettings(settings)

  return {
    client: new OnePasswordClient({ baseUrl, token, timeoutMs: resolved.timeoutMs }),
    baseUrl,
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

/**
 * Extract a human-readable error from a SCIM error response body. RFC 7644
 * SS3.12 defines the error envelope as `{ schemas, status, detail }`; this
 * also tolerates a plain `{ message }` body in case the bridge (or a proxy
 * in front of it) returns a non-SCIM error for e.g. a 502/504.
 */
export function scimErrorMessage(res: OnePasswordResponse): string {
  const parsed = parseJson<{ detail?: string; message?: string }>(res.body)
  if (parsed?.detail) return parsed.detail
  if (parsed?.message) return parsed.message
  return res.body || `HTTP ${res.status}`
}
