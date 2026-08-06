// =============================================================================
// Kandji tenant API client.
//
// Auth is a single Bearer API token, generated per-tenant in the Kandji web
// app (Settings > Access > API Token) and sent as `Authorization: Bearer
// <token>` on every request — no token exchange, no expiry to manage. Verified
// directly against Kandji's own rendered API reference
// (https://api-docs.kandji.io, which now redirects to
// https://api-docs.iru.com/ — the vendor rebranded to "Iru" but its docs
// banner states plainly: "Kandji is now Iru, but many URLs and notes within
// this documentation will continue to reference Kandji for some time." The
// API host, auth header and every route below are unchanged for existing
// tenants) and against the base-URL construction in Kandji's own published
// example scripts (github.com/kandji-inc/support/tree/main/api-tools).
//
// Base URL is per-tenant, entered as the Connection's endpoint and carried
// through as the deploy-target Component's hostname (the same "endpoint IS
// the host" pattern apps/okta-identity and apps/pagerduty use):
//   US region:  https://<subdomain>.api.kandji.io
//   EU region:  https://<subdomain>.api.eu.kandji.io
// There is no separate "subdomain"/"region" app setting — whichever full host
// the operator pastes into the Connection's endpoint (copied verbatim from
// Kandji's own Settings > Access page) becomes the Component hostname this
// client builds `https://<hostname>/api/v1/...` from.
//
// Every JSON list endpoint this app uses (blueprints, tags, custom-scripts,
// custom-profiles) returns the same Django-REST-Framework-shaped envelope:
// `{count, next, previous, results}`, where `next` is a full absolute URL for
// the next page (or null on the last page) — `listAll()` below simply follows
// `next` rather than guessing whether a given endpoint's own query parameter
// is `limit`/`offset` (Blueprints) or `page` (Library Items); both still work
// for page 1 since `next` is what the API itself returns.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout
// and never throws on an HTTP error status — callers inspect `.error`/`.data`
// on a NON-UNION response so they narrow without control-flow help.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_PAGE_SIZE = 100
const MAX_LIST_PAGES = 500

// --- Settings ----------------------------------------------------------------

export interface KandjiSettings {
  timeoutMs: number
  pageSize: number
}

export function readKandjiSettings(settings: Record<string, unknown>): KandjiSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  const rawPageSize = settings.page_size
  const pageSize =
    typeof rawPageSize === 'number' && Number.isFinite(rawPageSize) && rawPageSize > 0
      ? Math.floor(rawPageSize)
      : DEFAULT_PAGE_SIZE

  return { timeoutMs, pageSize }
}

// --- Credentials ---------------------------------------------------------------

/** Extract the Kandji API token from a Veltrix credential ("API token", falling back to "password"). */
export function resolveKandjiToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Kandji API token available — generate one in the Kandji web app (Settings > Access > API Token) ' +
  'and store it in the credential\'s "API token" field. The app sends it as "Authorization: Bearer <token>".'

export const MISSING_ENDPOINT_MESSAGE =
  'No Kandji tenant configured — register a "kandji-tenant" component (or save a Connection with an ' +
  'endpoint) whose host is your Kandji API URL from Settings > Access, e.g. ' +
  'yourcompany.api.kandji.io (US) or yourcompany.api.eu.kandji.io (EU).'

// --- Transport -----------------------------------------------------------------

/**
 * The outcome of one API call. NON-UNION: every field is always present so a
 * handler reads `.error`/`.data` without narrowing help from the platform's
 * handler loader.
 *   - `error` is non-null for a network failure, a timeout, or a non-2xx HTTP
 *     status.
 *   - `data` is the parsed JSON body (null for a 204 No Content, or on error).
 */
export interface KandjiApiResponse<T = unknown> {
  status: number
  data: T | null
  error: string | null
}

export type KandjiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** DRF-shaped list envelope shared by every list endpoint this app uses. */
export interface KandjiListEnvelope<T> {
  count?: number
  next?: string | null
  previous?: string | null
  results?: T[]
}

export class KandjiClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs: number }) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs
  }

  get baseUrl(): string {
    return this.base
  }

  /** JSON request against `${baseUrl}${path}` (path e.g. `/api/v1/tags`). */
  async request<T = unknown>(
    method: KandjiMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<KandjiApiResponse<T>> {
    const url = new URL(`${this.base}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.sendJson<T>(method, url.toString(), opts.body)
  }

  /** Follow an absolute URL (a `next` page link) with a JSON GET. */
  async sendAbsolute<T = unknown>(url: string): Promise<KandjiApiResponse<T>> {
    return this.sendJson<T>('GET', url, undefined)
  }

  private async sendJson<T>(method: KandjiMethod, url: string, body: unknown): Promise<KandjiApiResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json;charset=utf-8' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.status === 204) return { status: res.status, data: null, error: null }
      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, data: null, error: kandjiErrorMessage(res.status, text) }
      }
      const parsed = parseJson<T>(text)
      if (text && parsed === null) {
        return { status: res.status, data: null, error: 'Kandji returned a non-JSON response' }
      }
      return { status: res.status, data: parsed, error: null }
    } catch (err) {
      return { status: 0, data: null, error: err instanceof Error ? err.message : `${method} ${url} failed` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * `application/x-www-form-urlencoded` request — used only by Blueprints
   * (create/update), whose "Body: urlencoded" shape in Kandji's own API
   * reference uses flat, sometimes dotted, keys (e.g. `enrollment_code.code`)
   * rather than a nested JSON object.
   */
  async requestUrlEncoded<T = unknown>(
    method: 'POST' | 'PATCH',
    path: string,
    fields: Record<string, string>,
  ): Promise<KandjiApiResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const body = new URLSearchParams(fields)
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.status === 204) return { status: res.status, data: null, error: null }
      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, data: null, error: kandjiErrorMessage(res.status, text) }
      }
      const parsed = parseJson<T>(text)
      if (text && parsed === null) {
        return { status: res.status, data: null, error: 'Kandji returned a non-JSON response' }
      }
      return { status: res.status, data: parsed, error: null }
    } catch (err) {
      return { status: 0, data: null, error: err instanceof Error ? err.message : `${method} ${path} failed` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Multipart request — used only by Custom Profiles (create/update), whose
   * `.mobileconfig` payload the Kandji API accepts as a `file` form part, not
   * an embedded JSON string. No `Content-Type` header is set here so
   * fetch/undici generates the correct `multipart/form-data; boundary=...`
   * value itself.
   */
  async requestMultipart<T = unknown>(
    method: 'POST' | 'PATCH',
    path: string,
    form: FormData,
  ): Promise<KandjiApiResponse<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        body: form,
        signal: controller.signal,
      })
      const text = await res.text()

      if (res.status === 204) return { status: res.status, data: null, error: null }
      if (res.status < 200 || res.status >= 300) {
        return { status: res.status, data: null, error: kandjiErrorMessage(res.status, text) }
      }
      const parsed = parseJson<T>(text)
      if (text && parsed === null) {
        return { status: res.status, data: null, error: 'Kandji returned a non-JSON response' }
      }
      return { status: res.status, data: parsed, error: null }
    } catch (err) {
      return { status: 0, data: null, error: err instanceof Error ? err.message : `${method} ${path} failed` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Page through a DRF-shaped list endpoint (`{count, next, previous,
   * results}`), following the envelope's own `next` URL until it is null.
   * `initialQuery` seeds page 1 only — every subsequent page is fetched via
   * the absolute `next` URL Kandji itself returns.
   */
  async listAll<T = unknown>(
    path: string,
    initialQuery: Record<string, string | number | boolean | undefined> = {},
  ): Promise<{ nodes: T[]; error: string | null }> {
    const nodes: T[] = []
    let res = await this.request<KandjiListEnvelope<T>>('GET', path, { query: initialQuery })

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (res.error) return { nodes, error: res.error }
      const results = res.data?.results
      if (!Array.isArray(results)) {
        return { nodes, error: `Kandji response for "${path}" is missing "results"` }
      }
      nodes.push(...results)
      const next = res.data?.next
      if (!next) break
      res = await this.sendAbsolute<KandjiListEnvelope<T>>(next)
    }
    return { nodes, error: null }
  }
}

// --- Client construction -----------------------------------------------------

/** Reduce a component hostname to a bare `<host>` — no scheme, no path, no trailing slash. */
function normalizeHost(hostname: string | undefined): string | null {
  let host = (hostname ?? '').trim()
  if (!host) return null
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  return host || null
}

/** Build a client from a deploy-target component's hostname, a credential and app settings. */
export function buildKandjiClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: KandjiClient; baseUrl: string } | { error: string } {
  const token = resolveKandjiToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = normalizeHost(hostname)
  if (!host) return { error: MISSING_ENDPOINT_MESSAGE }

  const resolved = readKandjiSettings(settings)
  const baseUrl = `https://${host}`
  return { client: new KandjiClient({ baseUrl, token, timeoutMs: resolved.timeoutMs }), baseUrl }
}

// --- Shared helpers ------------------------------------------------------------

/** Parse a JSON body, returning null instead of throwing on malformed/empty content. */
export function parseJson<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/**
 * Render a Kandji (Django REST Framework) error body as one readable line.
 * Kandji's errors are either `{"detail": "..."}` (auth/permission/not-found),
 * a flat `{"message": "..."}`/`{"error": "..."}`, or field-level validation
 * errors shaped `{"<field>": ["msg", ...], ...}` — handle all three rather
 * than assuming one, since no single error shape is documented across every
 * endpoint this app calls.
 */
export function kandjiErrorMessage(status: number, body: string): string {
  const parsed = parseJson<Record<string, unknown>>(body)
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.detail === 'string') return `HTTP ${status}: ${parsed.detail}`
    if (typeof parsed.message === 'string') return `HTTP ${status}: ${parsed.message}`
    if (typeof parsed.error === 'string') return `HTTP ${status}: ${parsed.error}`

    const fieldErrors = Object.entries(parsed)
      .map(([field, value]) => {
        const messages = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
        return messages.length > 0 ? `${field}: ${messages.join('; ')}` : null
      })
      .filter((s): s is string => s !== null)
    if (fieldErrors.length > 0) return `HTTP ${status}: ${fieldErrors.join(' | ')}`
  }
  const trimmed = (body ?? '').replace(/\s+/g, ' ').trim()
  if (!trimmed) return `HTTP ${status}`
  return `HTTP ${status}: ${trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed}`
}
