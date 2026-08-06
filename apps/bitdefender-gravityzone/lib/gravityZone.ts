// =============================================================================
// Bitdefender GravityZone Control Center Public API client.
//
// GravityZone's automation surface is a JSON-RPC 2.0 API — NOT REST. One
// endpoint PER SERVICE:
//
//   POST https://<host>/api/v1.0/jsonrpc/<service>
//     Content-Type: application/json
//     { "id": "<any>", "jsonrpc": "2.0", "method": "<methodName>", "params": {...} }
//
//   -> { "id": "<same>", "jsonrpc": "2.0", "result": {...} }
//   -> { "id": "<same>", "jsonrpc": "2.0", "error": { "code": ..., "message": "...", "data": {...} } }
//
// Services this app calls: general, accounts, companies, network, policies,
// packages, push, integrations — each config type's lib/gravityZoneApi.ts
// wrapper cites the exact Bitdefender support doc page for its method(s),
// e.g. https://www.bitdefender.com/business/support/en/77209-140282-getapikeydetails.html.
// One method (policies.getPolicyDetails) is documented at API version v1.1
// rather than the default v1.0 — see lib/gravityZoneApi.ts.
//
// Auth is a single API key generated in the Control Center under My Account >
// API keys (scoped to the action categories it may call), sent as HTTP Basic
// with the key as the username and an EMPTY password:
//   Authorization: Basic base64("<apiKey>:")
// There is no session/token exchange — every request carries the same header.
//
// This client's request/auth shape was cross-verified against the community
// n8n-nodes-gravityzone integration (https://github.com/DainArtz/n8n-nodes-gravityzone,
// TypeScript, actively maintained, built directly against this same public
// API — transport/requestApi.ts and credentials/GravityZoneApi.credentials.ts),
// in addition to the per-method Bitdefender support doc pages cited per
// resource in gravityZoneApi.ts. The default API host
// (cloud.gravityzone.bitdefender.com/api) matches that integration's default
// credential and this app's own connectivity test.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { randomUUID } from 'node:crypto'

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_API_VERSION = 'v1.0'

export interface GravityZoneSettings {
  timeoutMs: number
}

export function readGravityZoneSettings(settings: Record<string, unknown>): GravityZoneSettings {
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout * 1000 : REQUEST_TIMEOUT_MS
  return { timeoutMs }
}

/** The API key is stored as the connection credential's "API token" (or "password"); no username is used. */
export function resolveGravityZoneApiKey(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const key = (credential.apiToken ?? credential.password ?? '').trim()
  return key.length > 0 ? key : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No GravityZone API key available — generate one in the GravityZone Control Center under ' +
  'My Account > API keys (grant it every action category this app needs: Network, Policy, ' +
  'Packages, Companies, Accounts, Push notifications, Integrations, General), then store it in ' +
  'the credential\'s "API token" field. See ' +
  'https://www.bitdefender.com/business/support/en/77212-125277-public-api.html.'

export const MISSING_ENDPOINT_MESSAGE =
  'No GravityZone API host configured — register a "gravityzone-tenant" component whose hostname ' +
  'is your GravityZone Control Center API host (e.g. cloud.gravityzone.bitdefender.com for the ' +
  'default Cloud console, or your on-premises/regional Control Center\'s hostname).'

/** Normalize a component hostname into the JSON-RPC API's base URL (scheme + trailing /api, no trailing slash). */
export function buildBaseUrl(hostname: string): string {
  let host = hostname.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`
  if (!/\/api$/i.test(host)) host = `${host}/api`
  return host
}

export interface GravityZoneErrorShape {
  code?: number
  message?: string
  data?: { details?: string } | unknown
}

/** A GravityZone JSON-RPC error response ({"error": {...}}), as opposed to a transport/HTTP failure. */
export class GravityZoneApiError extends Error {
  readonly code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'GravityZoneApiError'
    this.code = code
  }
}

export function parseJson<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

function classifyTransportError(err: unknown, url: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort/i.test(msg)) return `Timed out reaching GravityZone at ${url}.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve the GravityZone host for ${url}.`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${url}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${url}: ${msg}`
  return `Could not reach GravityZone (${url}): ${msg}`
}

/**
 * Client for the GravityZone Control Center Public API — see the module
 * comment above for the JSON-RPC envelope and auth this implements.
 */
export class GravityZoneClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; apiKey: string; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * Call one JSON-RPC method against one service and return its `result`.
   * Throws `GravityZoneApiError` on a JSON-RPC-level error (bad params,
   * insufficient API key rights, unknown object id, ...) and a plain `Error`
   * on a transport/HTTP-level failure (network, TLS, auth rejected, 5xx).
   */
  async call<T = unknown>(
    service: string,
    method: string,
    params: Record<string, unknown> = {},
    apiVersion: string = DEFAULT_API_VERSION,
  ): Promise<T> {
    const url = `${this.baseUrl}/${apiVersion}/jsonrpc/${service}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`,
        },
        body: JSON.stringify({ id: randomUUID(), jsonrpc: '2.0', method, params }),
        signal: controller.signal,
      })
    } catch (err) {
      throw new Error(classifyTransportError(err, url))
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    if (res.status === 401 || res.status === 403) {
      throw new Error(`GravityZone rejected the API key (HTTP ${res.status}) calling ${service}.${method}. Check the key is valid, enabled, and scoped for this action category.`)
    }
    if (!res.ok) {
      throw new Error(`GravityZone ${service}.${method} failed (HTTP ${res.status}): ${text.slice(0, 300)}`)
    }

    const parsed = parseJson<{ result?: T; error?: GravityZoneErrorShape }>(text)
    if (!parsed) {
      throw new Error(`GravityZone ${service}.${method} returned an unparseable response`)
    }
    if (parsed.error) {
      const dataObj = parsed.error.data && typeof parsed.error.data === 'object' ? (parsed.error.data as { details?: string }) : undefined
      const details = dataObj?.details
      throw new GravityZoneApiError(
        `GravityZone ${service}.${method} error${parsed.error.code !== undefined ? ` (code ${parsed.error.code})` : ''}: ${
          parsed.error.message ?? 'unknown error'
        }${details ? ` — ${details}` : ''}`,
        parsed.error.code,
      )
    }
    return (parsed.result ?? ({} as T)) as T
  }
}

/** Build a client from a component hostname, a credential, and app settings — or the reason it cannot be built. */
export function buildGravityZoneClient(
  hostname: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: GravityZoneClient; baseUrl: string } | { error: string } {
  const apiKey = resolveGravityZoneApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }
  const host = hostname?.trim()
  if (!host) return { error: MISSING_ENDPOINT_MESSAGE }
  const resolved = readGravityZoneSettings(settings)
  const baseUrl = buildBaseUrl(host)
  return { client: new GravityZoneClient({ baseUrl, apiKey, timeoutMs: resolved.timeoutMs }), baseUrl }
}
