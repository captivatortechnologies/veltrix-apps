// =============================================================================
// Auth0 access seam.
//
// One path: HTTPS REST against the Auth0 Management API v2 on the tenant domain
// (`https://<tenant>.auth0.com/api/v2/`). Auth0 is a public SaaS with valid TLS,
// so the transport is the platform's global `fetch` (no self-signed handling,
// unlike MISP/Splunk which talk to on-prem tiers).
//
// Auth is a Management API access token minted via the OAuth2 client-credentials
// grant against the tenant's own `/oauth/token`:
//   POST https://<tenant>.auth0.com/oauth/token
//   { grant_type: client_credentials, client_id, client_secret,
//     audience: https://<tenant>.auth0.com/api/v2/ }
//   → { access_token, token_type: "Bearer", expires_in, scope }
// The access token is then sent as `Authorization: Bearer <access_token>`.
//
// The connection stores the Machine-to-Machine credential as: username = Client
// ID, apiToken = Client Secret; the endpoint/hostname is the tenant domain.
//
// Docs:
//   Token flow: https://auth0.com/docs/secure/tokens/access-tokens/management-api-access-tokens/get-management-api-access-tokens-for-production
//   Clients:    https://auth0.com/docs/api/management/v2/clients/get-clients
// =============================================================================

import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

type ProviderLike = { config?: Record<string, unknown> | null } | null

/**
 * The bare Auth0 tenant domain (no scheme, no trailing slash, no `/api/v2` path),
 * e.g. `acme.us.auth0.com`. Prefers an explicit connectivity URL, then the
 * provider's configured device address, then the component hostname.
 */
export function resolveDomain(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  provider?: ProviderLike,
): string {
  const explicit = connectivity?.httpsUrl
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  const raw =
    (typeof explicit === 'string' && explicit) ||
    (typeof deviceAddress === 'string' && deviceAddress) ||
    component.hostname ||
    ''
  return raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/\/+$/, '')
}

/** `https://<domain>/oauth/token` — where the client-credentials grant is exchanged. */
export function buildTokenUrl(domain: string): string {
  return `https://${domain}/oauth/token`
}

/** `https://<domain>/api/v2` — the Management API base (no trailing slash). */
export function buildApiBase(domain: string): string {
  return `https://${domain}/api/v2`
}

/** `https://<domain>/api/v2/` — the Management API audience for the token request. */
export function buildAudience(domain: string): string {
  return `https://${domain}/api/v2/`
}

/** Pull the Machine-to-Machine Client ID + Client Secret from a stored credential. */
export function resolveClientCredentials(
  credential: CredentialRef | null | undefined,
): { clientId: string; clientSecret: string } | null {
  const clientId = credential?.username?.trim()
  const clientSecret = credential?.apiToken?.trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export interface Auth0Response {
  status: number
  ok: boolean
  body: string
}

/** One HTTPS request against Auth0 with an abortable timeout. */
export async function auth0Fetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<Auth0Response> {
  const timeoutMs = init.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      body: init.body,
      signal: controller.signal,
    })
    const body = await res.text()
    return { status: res.status, ok: res.ok, body }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${new URL(url).host}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export interface ManagementToken {
  accessToken: string
  scope: string
  expiresIn: number
}

/**
 * Mint a Management API v2 access token with the OAuth2 client-credentials grant.
 * The body is `application/x-www-form-urlencoded` per the Auth0 production docs.
 * Throws with the tenant's error message on any non-2xx (bad client id/secret,
 * grant not authorized for the Management API audience, etc.).
 */
export async function fetchManagementToken(opts: {
  domain: string
  clientId: string
  clientSecret: string
  timeoutMs?: number
}): Promise<ManagementToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    audience: buildAudience(opts.domain),
  }).toString()

  const res = await auth0Fetch(buildTokenUrl(opts.domain), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    timeoutMs: opts.timeoutMs,
  })
  if (!res.ok) {
    throw new Error(`Token request failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`)
  }
  const parsed = JSON.parse(res.body || '{}') as {
    access_token?: string
    scope?: string
    expires_in?: number
  }
  if (!parsed.access_token) {
    throw new Error('Token request returned no access_token')
  }
  return { accessToken: parsed.access_token, scope: parsed.scope ?? '', expiresIn: parsed.expires_in ?? 0 }
}

/** Bearer authorization header for a minted Management API access token. */
export function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` }
}

export async function getJson<T>(url: string, accessToken: string, timeoutMs?: number): Promise<T> {
  const res = await auth0Fetch(url, { headers: bearer(accessToken), timeoutMs })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  accessToken: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const res = await auth0Fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...bearer(accessToken) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}

/** DELETE a Management API resource. Auth0 returns 204 No Content on success. */
export async function deleteResource(url: string, accessToken: string, timeoutMs?: number): Promise<void> {
  const res = await auth0Fetch(url, { method: 'DELETE', headers: bearer(accessToken), timeoutMs })
  if (!res.ok) throw new Error(`DELETE ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
}

/**
 * Read every page of a Management API offset-paginated list endpoint.
 * `buildUrl(page)` returns the full URL for that zero-based page (the caller
 * embeds `per_page`, `fields`, and any filters). Pagination stops at an empty
 * or short page, or after `maxPages` — a generous ceiling, not a real limit
 * (Auth0's offset pagination itself caps at 1000 results for most endpoints;
 * a tenant beyond that should filter with query params the caller adds to
 * `buildUrl`). Shared by every list-and-upsert-by-identity config type
 * (clients, connections, resource-servers, roles, and the config types added
 * on top of them) so the pagination loop is written once.
 */
export async function listAllPages<T>(
  buildUrl: (page: number) => string,
  accessToken: string,
  opts: { perPage?: number; maxPages?: number; timeoutMs?: number } = {},
): Promise<T[]> {
  const perPage = opts.perPage ?? 100
  const maxPages = opts.maxPages ?? 50
  const all: T[] = []
  for (let page = 0; page < maxPages; page++) {
    const batch = await getJson<T[]>(buildUrl(page), accessToken, opts.timeoutMs)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < perPage) break
  }
  return all
}

/**
 * GET a Management API resource that returns raw text/HTML rather than JSON —
 * the Universal Login custom-page template (`/branding/templates/universal-login`)
 * is the one endpoint on this surface shaped this way. Returns `null` on a 404
 * (no custom template set — the tenant is on the Auth0-managed default).
 */
export async function getTextOrNull(url: string, accessToken: string, timeoutMs?: number): Promise<string | null> {
  const res = await auth0Fetch(url, { headers: { Accept: 'text/html', ...bearer(accessToken) }, timeoutMs })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return res.body
}

/** PUT raw text/HTML to a Management API resource (see {@link getTextOrNull}). */
export async function putText(url: string, accessToken: string, body: string, timeoutMs?: number): Promise<void> {
  const res = await auth0Fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html', ...bearer(accessToken) },
    body,
    timeoutMs,
  })
  if (!res.ok) throw new Error(`PUT ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
}
