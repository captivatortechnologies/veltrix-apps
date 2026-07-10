// ========================================================================
// Access Servers — the Zero-Trust Access (ZTNA) gateways an app manages.
//
// Each Access Server is a ZTNA gateway (name + endpoint) a customer has
// registered, optionally linked to one of their connectivity providers. These
// helpers are a typed, convenient surface over the platform's access-servers
// API (/api/access-servers), plus a thin reader over the connectivity
// providers API (/api/connectivity-providers) used to populate the ZTNA link
// picker.
//
// Framework-free (no React) — safe to import from any client code. Every call
// goes through the same `authFetch` the '/client' subpath exports, so requests
// carry the platform's Authorization header. Non-2xx responses are surfaced as
// thrown Errors carrying the platform's error text.
// ========================================================================

import type {
  AccessServer,
  AccessServerInput,
  ConnectivityProviderRef,
} from '../types/platform'
import { authFetch } from './index'

/** Base route for the platform's access-servers API. */
const ACCESS_SERVERS_API = '/api/access-servers'
/** Base route for the platform's connectivity-providers API (ZTNA picker). */
const CONNECTIVITY_PROVIDERS_API = '/api/connectivity-providers'

/**
 * Loosely-typed shape of a raw access server as returned by the platform,
 * before it is normalized down to the {@link AccessServer} surface.
 */
interface RawAccessServer {
  id: string
  name?: string
  endpoint?: string
  type?: string
  region?: string | null
  status?: string
  description?: string | null
  connectivityProviderId?: string | null
  connectivityProvider?: { id: string; name: string } | null
}

/**
 * Loosely-typed shape of a raw connectivity provider as returned by the
 * platform, before it is normalized to the {@link ConnectivityProviderRef}
 * picker surface.
 */
interface RawConnectivityProvider {
  id: string
  name?: string
  providerType?: string
  status?: string
}

/** Build an Error from a non-2xx response, preferring the platform's message. */
async function accessServerError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: string; message?: string }
      const message = body?.error ?? body?.message
      if (message) return new Error(message)
    } catch {
      // Body was not JSON — fall through and use the raw text.
    }
    return new Error(text)
  }
  return new Error(`HTTP ${res.status}`)
}

/** Normalize a raw platform access server into the typed AccessServer surface. */
function toAccessServer(raw: RawAccessServer): AccessServer {
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    endpoint: raw.endpoint ?? '',
    type: raw.type ?? undefined,
    region: raw.region ?? null,
    status: raw.status ?? undefined,
    description: raw.description ?? null,
    connectivityProviderId: raw.connectivityProviderId ?? null,
    connectivityProvider: raw.connectivityProvider
      ? { id: String(raw.connectivityProvider.id), name: String(raw.connectivityProvider.name) }
      : null,
  }
}

/** List the customer's access servers (ZTNA gateways). GET /api/access-servers */
export async function listAccessServers(): Promise<AccessServer[]> {
  const res = await authFetch(ACCESS_SERVERS_API)
  if (!res.ok) throw await accessServerError(res)
  const data = (await res.json()) as RawAccessServer[]
  return Array.isArray(data) ? data.map(toAccessServer) : []
}

/** Add a new access server (ZTNA gateway). POST /api/access-servers */
export async function addAccessServer(input: AccessServerInput): Promise<AccessServer> {
  const res = await authFetch(ACCESS_SERVERS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await accessServerError(res)
  return toAccessServer((await res.json()) as RawAccessServer)
}

/** Update an existing access server. PUT /api/access-servers/:id */
export async function updateAccessServer(
  id: string,
  input: AccessServerInput,
): Promise<AccessServer> {
  const res = await authFetch(`${ACCESS_SERVERS_API}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw await accessServerError(res)
  return toAccessServer((await res.json()) as RawAccessServer)
}

/** Remove an access server. DELETE /api/access-servers/:id */
export async function removeAccessServer(id: string): Promise<void> {
  const res = await authFetch(`${ACCESS_SERVERS_API}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  // 204 No Content is the platform's success response for delete.
  if (!res.ok && res.status !== 204) throw await accessServerError(res)
}

/**
 * List the customer's ZTNA connectivity providers, used to populate the Access
 * Server link picker. GET /api/connectivity-providers (the endpoint may return
 * a bare array or a paginated `{ data, ... }` shape — both are handled).
 */
export async function listConnectivityProviders(): Promise<ConnectivityProviderRef[]> {
  const res = await authFetch(CONNECTIVITY_PROVIDERS_API)
  if (!res.ok) throw await accessServerError(res)
  const body = (await res.json()) as unknown
  const providers: RawConnectivityProvider[] = Array.isArray(body)
    ? (body as RawConnectivityProvider[])
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: RawConnectivityProvider[] }).data)
      : []
  return providers.map((provider) => ({
    id: String(provider.id),
    name: provider.name ?? '',
    providerType: provider.providerType ?? undefined,
    status: provider.status ?? undefined,
  }))
}
