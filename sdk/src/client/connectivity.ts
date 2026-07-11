// ========================================================================
// Connectivity providers — the customer's ZTNA providers (Tailscale,
// WireGuard, ZeroTier, …), platform-managed under Settings → Connectivity.
//
// A thin reader over the platform's connectivity-providers API
// (/api/connectivity-providers), used to populate the ZTNA link picker when
// creating or editing an Access Server (a component). Framework-free — every
// call goes through the same `authFetch` the '/client' subpath exports.
// ========================================================================

import type { ConnectivityProviderRef } from '../types/platform'
import { authFetch } from './index'

/** Base route for the platform's connectivity-providers API. */
const CONNECTIVITY_PROVIDERS_API = '/api/connectivity-providers'

interface RawConnectivityProvider {
  id: string
  name?: string
  providerType?: string
  status?: string
}

/** Build an Error from a non-2xx response, preferring the platform's message. */
async function providerError(res: Response): Promise<Error> {
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

/**
 * List the customer's ZTNA connectivity providers, used to populate the Access
 * Server link picker. GET /api/connectivity-providers (the endpoint may return
 * a bare array or a paginated `{ data, ... }` shape — both are handled).
 */
export async function listConnectivityProviders(): Promise<ConnectivityProviderRef[]> {
  const res = await authFetch(CONNECTIVITY_PROVIDERS_API)
  if (!res.ok) throw await providerError(res)
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
