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

/** Accept management base URLs or bare hosts; bare hosts use splunkd's port. */
export function normalizeSplunkUrl(raw: string, defaultPort: string | number = DEFAULT_MANAGEMENT_PORT): string {
  const value = raw.trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  const url = new URL(hasScheme ? value : `https://${value}`)
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a Splunk management HTTP(S) URL without embedded credentials, query parameters or fragments')
  }
  const explicitPort = /:\d+$/.test(value.split('/')[0])
  if (!hasScheme && !url.port && !explicitPort) url.port = String(defaultPort)
  return url.href.replace(/\/+$/, '')
}

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
  settings: Record<string, unknown> = {},
): string {
  const port = component.port || String(settings.splunk_api_port || DEFAULT_MANAGEMENT_PORT)
  if (connectivity?.httpsUrl) return normalizeSplunkUrl(connectivity.httpsUrl)
  if (connectivity?.tailscaleDeviceIP) return normalizeSplunkUrl(connectivity.tailscaleDeviceIP, port)
  const deviceAddress = (connectivityProvider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return normalizeSplunkUrl(deviceAddress, port)
  return normalizeSplunkUrl(component.hostname, port)
}

/**
 * True when `buildSplunkUrl` has something real to resolve. A component with a
 * hostname needs neither a connectivity record nor a ZTNA provider: the
 * connection test reaches it by address, so a deploy must too.
 */
export function hasSplunkAddress(
  component: ComponentRef,
  connectivity: ConnectivityRef | null,
  connectivityProvider?: { config?: Record<string, unknown> | null } | null,
): boolean {
  if (connectivity?.httpsUrl || connectivity?.tailscaleDeviceIP) return true
  const deviceAddress = (connectivityProvider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return true
  return typeof component.hostname === 'string' && component.hostname.trim() !== ''
}

export const NO_ADDRESS_MESSAGE =
  'No address for this Splunk instance: set the component hostname or attach connectivity (HTTPS URL or managed ZTNA)'

/** Bearer token when an API token is configured, otherwise HTTP Basic. */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken?.trim()) {
    return { Authorization: `Bearer ${credential.apiToken.trim()}` }
  }
  if (!credential.username?.trim() || !credential.password) throw new Error('Attach a Splunk authentication token or a username and password; HEC ingestion tokens cannot authenticate to the management API')
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
 * (WireGuard-encrypted end to end). This legacy transport accepts self-signed
 * certificates; it does not verify server identity. Use trusted private routing
 * until an explicit verified-TLS/custom-CA policy is implemented.
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
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      reject(new Error('Invalid Splunk management URL'))
      return
    }
    // Normalize the body to a Buffer up front so we can send an explicit
    // Content-Length. Without it, node:http streams the body with
    // `Transfer-Encoding: chunked`, which splunkd's multipart parser rejects
    // ("Unparsable URI-encoded request data") on a .spl package upload — undici's
    // fetch always framed these with Content-Length.
    const bodyBuf =
      init.body == null
        ? null
        : Buffer.isBuffer(init.body)
          ? init.body
          : typeof init.body === 'string'
            ? Buffer.from(init.body, 'utf8')
            : Buffer.from(init.body)
    const headers: Record<string, string> = { ...(init.headers ?? {}) }
    if (bodyBuf && headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = String(bodyBuf.length)
    }
    const doRequest = u.protocol === 'http:' ? httpRequest : httpsRequest
    const req = doRequest(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? '80' : '443'),
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('Splunk response was interrupted')))
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          resolve({ ok: status >= 200 && status < 300, status, text: async () => bodyText })
        })
      },
    )
    const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS
    const deadline = setTimeout(() => req.destroy(new Error(`Splunk request timed out after ${timeoutMs}ms`)), timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
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
 * or null ONLY when Splunk confirms that the entity does not exist.
 * Unreadable state must never be mistaken for permission to create/replace it.
 */
export async function getEntityContent(
  baseUrl: string,
  auth: Record<string, string>,
  entityPath: string,
): Promise<Record<string, unknown> | null> {
  const res = await splunkFetch(`${baseUrl}${entityPath}?output_mode=json`, { method: 'GET', headers: auth })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Could not read Splunk entity (HTTP ${res.status})`)
  return parseEntityContent(await res.text())
}

/** Reject login pages and malformed successful reads before trusting live state. */
export function parseEntityContent(body: string): Record<string, unknown> {
  const data = JSON.parse(body)
  const content = data?.entry?.[0]?.content
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error('Splunk entity response has no valid content')
  return content as Record<string, unknown>
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
