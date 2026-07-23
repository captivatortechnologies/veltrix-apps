import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
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

/**
 * Resolve the base URL for the Splunk management API on a component. Prefers an
 * explicit connectivity URL/device IP, then the managed-ZTNA tailnet address
 * (the platform is on the tailnet, so it can reach a `100.x` device the raw
 * `.local` hostname would never resolve to), then the hostname as a last resort.
 */
export function buildSplunkUrl(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  // Structural: the pipeline ConnectivityProviderRef carries the (decrypted) config
  // with `deviceAddress` for managed ZTNA; typed minimally to avoid the SDK's two
  // ConnectivityProviderRef exports (the AppContext one has no config).
  connectivityProvider?: { config?: Record<string, unknown> | null } | null,
): string {
  const port = component.port || DEFAULT_MANAGEMENT_PORT
  if (connectivity?.httpsUrl) return connectivity.httpsUrl
  if (connectivity?.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${port}`
  const deviceAddress = (connectivityProvider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return `https://${deviceAddress}:${port}`
  return `https://${component.hostname}:${port}`
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
  /** Form/JSON text, or raw bytes for a package upload. */
  body?: string | Uint8Array
  timeoutMs?: number
}

export interface SplunkFetchResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
}

/**
 * fetch() against the Splunk management API. splunkd listens on 8089 with a
 * SELF-SIGNED certificate by default, which the global `fetch` (undici) rejects
 * with an opaque "fetch failed". The connection already rides the managed tailnet
 * (WireGuard-encrypted end to end), so TLS verification here is redundant — we
 * accept the cert via node:https (no undici dispatcher needed).
 */
export interface SplunkFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  timeoutMs?: number
}

type SplunkTransport = (url: string, init: SplunkFetchInit) => Promise<SplunkFetchResponse>

/** Test-only seam: swap the HTTP transport (default: node:https, accepts self-signed). */
let activeTransport: SplunkTransport = nodeHttpsTransport
export function __setSplunkTransport(transport: SplunkTransport | null): void {
  activeTransport = transport ?? nodeHttpsTransport
}

export function splunkFetch(url: string, init: SplunkFetchInit = {}): Promise<SplunkFetchResponse> {
  return activeTransport(url, init)
}

function nodeHttpsTransport(url: string, init: SplunkFetchInit): Promise<SplunkFetchResponse> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch (err) {
      reject(err as Error)
      return
    }
    const doRequest = u.protocol === 'http:' ? httpRequest : httpsRequest
    const req = doRequest(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? '80' : '443'),
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: init.headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, text: async () => bodyText })
        })
      },
    )
    const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Splunk request timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    if (init.body != null) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body))
    req.end()
  })
}

/** Perform a request against splunkd, throwing on non-2xx responses. */
export async function splunkRequest(url: string, options: SplunkRequestOptions): Promise<string> {
  const res = await splunkFetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    timeoutMs: options.timeoutMs,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Splunk API ${res.status}: ${text}`)
  }
  return res.text()
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
 * GET a Splunk REST endpoint and parse its JSON response. Appends
 * `output_mode=json` (Splunk defaults to XML otherwise). Throws on a non-2xx
 * (via splunkRequest) or on invalid JSON — callers that need graceful
 * degradation wrap this in try/catch (see lib/liveLicense.ts).
 */
export async function getJson<T = any>(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
  timeoutMs?: number,
): Promise<T> {
  const sep = entityPath.includes('?') ? '&' : '?'
  const text = await splunkRequest(`${baseUrl}${entityPath}${sep}output_mode=json`, {
    method: 'GET',
    headers: auth,
    timeoutMs,
  })
  return JSON.parse(text) as T
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
