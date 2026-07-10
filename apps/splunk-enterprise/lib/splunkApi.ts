import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

// ========================================================================
// Shared Splunk management API helpers used by every pipeline handler.
//
// All handlers talk to splunkd's management port (default 8089) over the
// connectivity established by the platform (ctx.connectivity /
// ctx.connectivityProvider) using the credential from ctx.credential.
// ========================================================================

const DEFAULT_MANAGEMENT_PORT = '8089'
const REQUEST_TIMEOUT_MS = 30_000

/** Resolve the base URL for the Splunk management API on a component. */
export function buildSplunkUrl(component: ComponentRef, connectivity: ConnectivityRef): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) {
    return `https://${connectivity.tailscaleDeviceIP}:${component.port || DEFAULT_MANAGEMENT_PORT}`
  }
  return `https://${component.hostname}:${component.port || DEFAULT_MANAGEMENT_PORT}`
}

/** Bearer token when an API token is configured, otherwise HTTP Basic. */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) {
    return { Authorization: `Bearer ${credential.apiToken}` }
  }
  const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

export interface SplunkRequestOptions {
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs?: number
}

/** Perform a request against splunkd, throwing on non-2xx responses. */
export async function splunkRequest(url: string, options: SplunkRequestOptions): Promise<string> {
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
      throw new Error(`Splunk API ${res.status}: ${text}`)
    }

    return await res.text()
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * GET a single Splunk REST entity and return its `entry[0].content`,
 * or null when the entity does not exist / the request fails.
 */
export async function getEntityContent(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await splunkRequest(`${baseUrl}${entityPath}?output_mode=json`, {
      method: 'GET',
      headers: auth,
    })
    const data = JSON.parse(res)
    return (data?.entry?.[0]?.content as Record<string, unknown>) || null
  } catch {
    return null
  }
}

/**
 * Encode a Splunk REST payload as application/x-www-form-urlencoded.
 * Array values are appended once per element (Splunk's multi-value
 * convention for parameters like `capabilities` and `imported_roles`).
 * Undefined/null values are skipped.
 */
export function toFormBody(
  params: Record<string, string | number | boolean | string[] | undefined | null>,
): string {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) form.append(key, item)
    } else {
      form.append(key, String(value))
    }
  }
  return form.toString()
}

/** POST form data to a Splunk endpoint. */
export async function postForm(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
  params: Record<string, string | number | boolean | string[] | undefined | null>,
): Promise<string> {
  return splunkRequest(`${baseUrl}${entityPath}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: toFormBody(params),
  })
}
