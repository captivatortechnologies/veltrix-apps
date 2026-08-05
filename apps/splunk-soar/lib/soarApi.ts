import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

// ========================================================================
// Shared Splunk SOAR REST API helpers used by every pipeline handler.
//
// SOAR (formerly Phantom) exposes its REST API over HTTPS on the appliance's
// web port (default 443) at /rest/*. All handlers reach the instance over the
// connectivity established by the platform (ctx.connectivity) and authenticate
// with the credential from ctx.credential — an automation user API token
// (preferred, sent as the `ph-auth-token` header) or HTTP Basic as a fallback.
// ========================================================================

const DEFAULT_SOAR_PORT = '443'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Resolve the base URL for the Splunk SOAR REST API on a component.
 * `connectivity` is nullable because some newer SDK contexts type it that
 * way; a missing/empty one simply falls back to the component's hostname.
 */
export function buildSoarUrl(component: ComponentRef, connectivity: ConnectivityRef | null): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl
  if (connectivity?.tailscaleDeviceIP) {
    return `https://${connectivity.tailscaleDeviceIP}:${component.port || DEFAULT_SOAR_PORT}`
  }
  return `https://${component.hostname}:${component.port || DEFAULT_SOAR_PORT}`
}

/**
 * SOAR automation API token (ph-auth-token header) when configured, otherwise
 * HTTP Basic auth with the credential's username/password.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) {
    return { 'ph-auth-token': credential.apiToken }
  }
  const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

export interface SoarRequestOptions {
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** Perform a request against the SOAR REST API, throwing on non-2xx responses. */
export async function soarRequest(url: string, options: SoarRequestOptions): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Splunk SOAR API ${res.status}: ${text}`)
    }

    return await res.text()
  } finally {
    clearTimeout(timeout)
  }
}

// ========================================================================
// JSON transport + generic-record helpers for the config types beyond
// `connection` — Severities, Container Statuses, CEF Custom Fields, Roles,
// Assets, Automation Accounts, Custom Lists. Every one of these rides
// Splunk SOAR's uniform REST convention (docs.splunk.com SOAR PlatformAPI
// "Using the REST API" — Query for Data / Update Records / Delete Records):
//   list/read : GET    /rest/<type>[/<id>]   → { count, data: [...], num_pages }
//   create    : POST   /rest/<type>          body = the record
//   update    : POST   /rest/<type>/<id>     body = the record (full replace —
//               "any value you do not submit in your POST is reset to its
//               default value", per the Asset endpoint's own caution note)
//   delete    : DELETE /rest/<type>/<id>
//
// IMPORTANT: per the platform's "Delete Records" reference, DELETE requires a
// USER-authenticated credential (HTTP Basic) — an automation API token
// (ph-auth-token, this app's preferred credential) is rejected. Only Custom
// Lists document accepting token auth for DELETE. A rollback that deletes a
// newly-created record therefore surfaces a clear failure under a token-only
// credential rather than silently no-op'ing — see DELETE_AUTH_HINT below.
// ========================================================================

export const DELETE_AUTH_HINT =
  'Splunk SOAR restricts DELETE to a user-authenticated credential (username + password) — ' +
  'an automation API token cannot delete records. Attach a user credential capable of deletion ' +
  'if this rollback needs to remove a newly-created item.'

/** Perform a JSON request, throwing on non-2xx responses. */
async function soarJsonRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs?: number,
): Promise<string> {
  return soarRequest(url, {
    method,
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  })
}

/** GET a JSON resource (list or single record). */
export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs?: number): Promise<T> {
  const text = await soarJsonRequest('GET', url, headers, undefined, timeoutMs)
  return (text ? JSON.parse(text) : {}) as T
}

/** POST/DELETE a JSON body against the SOAR REST API, parsing the JSON response. */
export async function sendJson<T>(
  method: 'POST' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const text = await soarJsonRequest(method, url, headers, body, timeoutMs)
  return (text ? JSON.parse(text) : {}) as T
}

/** One row of a SOAR REST list response — every resource carries a numeric `id`. */
export interface SoarRecord {
  id?: number | string
  [key: string]: unknown
}

/**
 * Unwrap SOAR's uniform list envelope: `{ count, data: [...], num_pages }`
 * (confirmed identically for /rest/tenant, /rest/artifact, and every other
 * /rest/<type> list query — the platform's generic query engine). Falls back
 * to a bare array for safety.
 */
export function rowsFromList<T = SoarRecord>(list: unknown): T[] {
  if (Array.isArray(list)) return list as T[]
  if (list && typeof list === 'object' && Array.isArray((list as { data?: unknown }).data)) {
    return (list as { data: T[] }).data
  }
  return []
}

/**
 * List every row of a resource in one page (`page_size=0` = all results, per
 * the platform's Query for Data reference) — the config types here manage
 * small, admin-curated collections, never large user-generated data. `extraParams`
 * appends additional query params (e.g. `ph_user`'s `include_automation=true`,
 * required because automation-type users are excluded from the default list).
 */
export async function listAll<T = SoarRecord>(
  base: string,
  headers: Record<string, string>,
  resource: string,
  extraParams = '',
): Promise<T[]> {
  return rowsFromList<T>(await getJson<unknown>(`${base}/rest/${resource}?page_size=0${extraParams}`, headers))
}

/** Find a row by a named field, case-insensitively trimmed (the stable identity used to upsert). */
export function findByField<T extends Record<string, unknown>>(rows: T[], field: string, value: string): T | null {
  const target = value.trim().toLowerCase()
  if (!target) return null
  return rows.find((r) => String(r[field] ?? '').trim().toLowerCase() === target) ?? null
}
