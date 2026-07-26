// =============================================================================
// Rapid7 InsightIDR — Insight Platform (cloud) API client.
//
// InsightIDR does NOT live on the on-prem Security Console: it is a Command
// Platform (Insight) cloud product reached through a region-scoped endpoint:
//   https://<region>.api.insight.rapid7.com
// The SIEM (InsightIDR) Detection Rules API v1 is served under `/idr/v1` on that
// host; the platform-wide credential check is `GET /validate` at the root.
//
// Authentication is a single header — `X-Api-Key: <key>` — on every request
// (there is no username/password or OAuth flow). Create the key in the Insight
// platform under API Keys and store it in the Veltrix credential's API-token
// field.
//
// Region is data-residency-scoped and cannot be auto-discovered, so it must be
// supplied — encoded in the component hostname (`us.api.insight.rapid7.com` or
// the bare code `us`) or via the insightidr_region app setting. The component
// hostname is the primary channel because ctx.settings is not always populated
// for production deployments.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const PAGE_SIZE = 100
const DEFAULT_REGION = 'us'

// Region code → true. The Detection Rules API v1 spec enumerates us, us2, us3,
// ca, eu, au, ap; the platform additionally serves me1 (UAE) and aps2 (India)
// on the same `<code>.api.insight.rapid7.com` pattern, so they resolve too.
export const INSIGHTIDR_REGIONS = ['us', 'us2', 'us3', 'eu', 'ca', 'au', 'ap', 'me1', 'aps2'] as const

export interface InsightIDRSettings {
  region: string | null
  timeoutMs: number
}

/** Prototype-safe region membership test — canvas/settings values are user input. */
function isKnownRegion(code: string): boolean {
  return (INSIGHTIDR_REGIONS as readonly string[]).includes(code)
}

export function readInsightIDRSettings(settings: Record<string, unknown>): InsightIDRSettings {
  const rawRegion = settings.insightidr_region
  const region =
    typeof rawRegion === 'string' && isKnownRegion(rawRegion.trim().toLowerCase())
      ? rawRegion.trim().toLowerCase()
      : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { region, timeoutMs }
}

/**
 * Resolve the Insight region code from a component hostname, falling back to the
 * insightidr_region setting and finally the US region. The hostname may be:
 *   - a bare region code            → "us", "eu"
 *   - an Insight API/UI host        → "us.api.insight.rapid7.com", "eu.idr.insight.rapid7.com"
 *   - a full URL                    → "https://ca.api.insight.rapid7.com/idr/v1"
 * A host that matches the Insight domain uses its first label verbatim (so newer
 * region codes still resolve); a bare token is only accepted when it is a code
 * this client knows.
 */
export function resolveInsightIDRRegion(hostname: string | undefined, settings: InsightIDRSettings): string {
  let host = (hostname ?? '').trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')

  if (host) {
    const insightMatch = host.match(/^([a-z0-9]+)\.(?:api|idr)\.insight\.rapid7\.com$/)
    if (insightMatch) return insightMatch[1]
    if (isKnownRegion(host)) return host
  }

  return settings.region ?? DEFAULT_REGION
}

export interface InsightIDRCredential {
  apiKey: string
}

/** Extract the Insight platform API key from a Veltrix credential. */
export function resolveInsightIDRCredential(credential: CredentialRef | null): InsightIDRCredential | null {
  if (!credential) return null
  const apiKey = (credential.apiToken ?? credential.password ?? '').trim()
  if (!apiKey) return null
  return { apiKey }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No InsightIDR API key — create a key in the Insight platform (Platform Home → API Keys, an ' +
  'Organization key) and store it in the credential "API token" field. The region is taken from the ' +
  'component hostname (e.g. us.api.insight.rapid7.com) or the InsightIDR Region app setting.'

export interface InsightIDRResponse {
  status: number
  ok: boolean
  body: string
}

export type InsightIDRMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** Cursor-paginated collection envelope used by /idr/v1 list endpoints. */
export interface CursorCollection<T = unknown> {
  data?: T[]
  position?: string | null
}

export class InsightIDRClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; credential: InsightIDRCredential; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.credential.apiKey
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: InsightIDRMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<InsightIDRResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * GET every page of a cursor-paginated collection, concatenating `data`.
   * Pages follow the response `position` cursor until it is absent.
   */
  async getAll<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let position: string | undefined
    let lastStatus = 0
    let lastBody = ''
    const maxPages = 200
    for (let page = 0; page < maxPages; page++) {
      const res = await this.request('GET', path, { query: { ...query, size: PAGE_SIZE, position } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const envelope = parseJson<CursorCollection<T>>(res.body)
      const data = envelope?.data
      if (Array.isArray(data)) items.push(...data)
      const next = envelope?.position
      if (!next || !Array.isArray(data) || data.length === 0) break
      position = next
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }
}

/** Build a client from a component hostname, a credential and settings. */
export function buildInsightIDRClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: InsightIDRClient; baseUrl: string; region: string } | { error: string } {
  const cred = resolveInsightIDRCredential(credential)
  if (!cred) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readInsightIDRSettings(settings)
  const region = resolveInsightIDRRegion(hostname, resolved)
  const baseUrl = `https://${region}.api.insight.rapid7.com`

  return {
    client: new InsightIDRClient({ baseUrl, credential: cred, timeoutMs: resolved.timeoutMs }),
    baseUrl,
    region,
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from an InsightIDR API error response. */
export function insightIDRErrorMessage(res: InsightIDRResponse): string {
  const parsed = parseJson<{ message?: string; messages?: string[]; errors?: Array<string | { message?: string }> }>(
    res.body,
  )
  if (parsed?.message) return parsed.message
  if (Array.isArray(parsed?.messages) && parsed!.messages.length > 0) return parsed!.messages.join('; ')
  if (Array.isArray(parsed?.errors) && parsed!.errors.length > 0) {
    return parsed!.errors
      .map((e) => (typeof e === 'string' ? e : e?.message))
      .filter(Boolean)
      .join('; ')
  }
  if (res.status === 401) return 'HTTP 401: the InsightIDR API key was rejected — check the key and its region'
  if (res.status === 403) return 'HTTP 403: the InsightIDR API key lacks permission for this operation'
  return res.body || `HTTP ${res.status}`
}
