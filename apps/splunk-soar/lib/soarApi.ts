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

/** Resolve the base URL for the Splunk SOAR REST API on a component. */
export function buildSoarUrl(component: ComponentRef, connectivity: ConnectivityRef): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) {
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
