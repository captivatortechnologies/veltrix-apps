// =============================================================================
// OpenCTI access seam.
//
// One path: HTTPS GraphQL against the OpenCTI web/API tier. Self-hosted OpenCTI
// commonly ships a self-signed certificate, so the transport accepts untrusted
// certs (same posture as misp's mispApi / security-onion's soConsole) via
// node:https with rejectUnauthorized:false.
//
// Auth is the user's OpenCTI API token (from their profile → API access) carried
// as a Bearer token: `Authorization: Bearer <apiToken>`. The token is stored as
// the connection credential's apiToken.
//
// NOTE: The GraphQL surface here follows OpenCTI conventions (POST /graphql,
// `about { version }`, `me { id name }`). Verify against a live OpenCTI instance.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { ComponentRef, ConnectivityRef, CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_OPENCTI_PORT = 443

type ProviderLike = { config?: Record<string, unknown> | null } | null

function resolveHost(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.tailscaleDeviceIP) return connectivity.tailscaleDeviceIP
  const deviceAddress = (provider?.config as Record<string, unknown> | undefined)?.deviceAddress
  if (typeof deviceAddress === 'string' && deviceAddress) return deviceAddress
  return component.hostname
}

/** HTTPS base for the OpenCTI web UI / GraphQL API. Prefers an explicit URL. */
export function buildOpenctiUrl(component: ComponentRef, connectivity: ConnectivityRef | null, provider?: ProviderLike): string {
  if (connectivity?.httpsUrl) return connectivity.httpsUrl.replace(/\/+$/, '')
  const port = component.port || DEFAULT_OPENCTI_PORT
  return `https://${resolveHost(component, connectivity, provider)}${String(port) === '443' ? '' : `:${port}`}`
}

/**
 * OpenCTI authorization header. The API token is sent as a Bearer token. Returns
 * an empty object when no token is present — callers require a credential before
 * applying anything.
 */
export function buildAuthHeader(credential: CredentialRef): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  return {}
}

export interface OpenctiResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request that tolerates OpenCTI's self-signed certificate. Uses
 * node:https directly so the platform's global fetch settings don't reject the
 * untrusted cert. OpenCTI's GraphQL endpoint answers JSON on POST.
 */
export function openctiRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<OpenctiResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? 15_000
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: false, // self-hosted OpenCTI commonly ships self-signed certs
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${u.host}`)))
    if (init.body) req.write(init.body)
    req.end()
  })
}

/** A GraphQL response envelope: `{ data, errors }`. */
export interface GraphqlEnvelope<T> {
  data?: T
  errors?: Array<{ message?: string }>
}

/**
 * POST a GraphQL query/mutation to `<base>/graphql` and return its `data`. Throws
 * on a non-2xx transport status OR on a GraphQL `errors` payload — callers treat
 * a resolved value as a successful operation. Verify against a live OpenCTI
 * instance.
 */
export async function graphql<T>(
  base: string,
  headers: Record<string, string>,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const res = await openctiRequest(`${base}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
    timeoutMs,
  })
  if (!res.ok) throw new Error(`GraphQL ${base}/graphql → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  const parsed = JSON.parse(res.body || '{}') as GraphqlEnvelope<T>
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`GraphQL error: ${parsed.errors.map((e) => e.message ?? 'unknown').join('; ')}`)
  }
  return parsed.data as T
}

/** GraphQL to read the running OpenCTI version. Fallback proves the token by reading the caller. */
const ABOUT_VERSION_QUERY = 'query { about { version } }' // verify against a live OpenCTI instance
const ME_QUERY = 'query { me { id name } }' // fallback — proves the token authenticates

/**
 * Best-effort connectivity/version probe: try `about { version }`, fall back to
 * `me { id name }`. Returns the version string when known, `'connected'` when only
 * `me` succeeded, or null when neither returned data. Verify both against a live
 * OpenCTI instance.
 */
export async function fetchVersion(base: string, headers: Record<string, string>, timeoutMs?: number): Promise<string | null> {
  try {
    const data = await graphql<{ about?: { version?: string | null } }>(base, headers, ABOUT_VERSION_QUERY, {}, timeoutMs)
    if (data?.about?.version) return data.about.version
  } catch {
    // fall through to the `me` probe
  }
  const me = await graphql<{ me?: { id?: string | null; name?: string | null } }>(base, headers, ME_QUERY, {}, timeoutMs)
  return me?.me?.id ? 'connected' : null
}
