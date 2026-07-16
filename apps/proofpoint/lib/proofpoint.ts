// =============================================================================
// Proofpoint Essentials Interface API client (v1).
//
// Auth is the admin account's credentials sent on every request as the headers
// `X-User` (the admin's full email address) and `X-Password`. The account must be
// an Organization Admin or Channel Admin and NOT read-only. Calls hang off
// https://<stack>.proofpointessentials.com/api/v1/ where <stack> is the data
// region the organization lives in (us1..us5, eu1). Organizations are addressed
// by their primary domain: /orgs/{orgDomain}. Users, domains and the org object
// (which carries the Safe/Blocked sender lists) are noun-URL resources operated
// on with GET/POST/PUT/DELETE.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok`. A 429 is
// honored with a short backoff (Essentials does not document a Retry-After).
//
// Refs: help.proofpoint.com Essentials "API // Domains", "Sender List Information
// via API"; the Essentials Interface API docs at
// https://{stack}.proofpointessentials.com/api/v1/docs/index.php.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BACKOFF_MS = 3_000
const DEFAULT_STACK_HOST = 'us1.proofpointessentials.com'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface PPSettings {
  orgDomain: string | null
  stackHost: string
  timeoutMs: number
}

/** Resolve the app settings that address the Essentials organization + region. */
export function readPPSettings(settings: Record<string, unknown>): PPSettings {
  const rawOrg = settings.org_domain
  const orgDomain =
    typeof rawOrg === 'string' && rawOrg.trim().length > 0 ? normalizeHost(rawOrg) : null

  const rawStack = settings.stack_host
  const stackHost =
    typeof rawStack === 'string' && rawStack.trim().length > 0
      ? normalizeHost(rawStack)
      : DEFAULT_STACK_HOST

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { orgDomain, stackHost, timeoutMs }
}

/** Strip scheme / path / whitespace from a host-ish string, lower-cased. */
export function normalizeHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()
}

export interface PPAuth {
  user: string
  password: string
}

/**
 * Extract the Essentials admin credentials from a Veltrix credential. Essentials
 * authenticates with an admin email (X-User) + password (X-Password), so this
 * reads the credential's `username` and `password`. Non-union { auth, error }.
 */
export function resolvePPAuth(credential: CredentialRef | null): { auth: PPAuth | null; error: string | null } {
  if (!credential) return { auth: null, error: MISSING_CREDENTIAL_MESSAGE }
  const user = (credential.username ?? '').trim()
  const password = (credential.password ?? '').trim()
  if (!user || !password) return { auth: null, error: MISSING_CREDENTIAL_MESSAGE }
  return { auth: { user, password }, error: null }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Proofpoint Essentials admin credentials — store the Organization/Channel Admin email in the ' +
  'credential "Username" field and its password in the "Password" field (the account must not be ' +
  'read-only). These are sent as the X-User / X-Password API headers.'

export const MISSING_ORG_MESSAGE =
  'No Proofpoint Essentials organization — set the "Organization (primary domain)" app setting to the ' +
  'primary domain of the organization this configuration manages (e.g. acme.com).'

export interface PPResponse {
  status: number
  ok: boolean
  body: string
}

export type PPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class PPClient {
  private readonly baseUrl: string
  private readonly auth: PPAuth
  private readonly org: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; auth: PPAuth; org: string; timeoutMs: number }) {
    this.baseUrl = opts.baseUrl
    this.auth = opts.auth
    this.org = opts.org
    this.timeoutMs = opts.timeoutMs
  }

  /** The organization primary domain this client is scoped to. */
  get orgDomain(): string {
    return this.org
  }

  /** Path prefix for org-scoped resources: `/orgs/{orgDomain}`. */
  get orgPath(): string {
    return `/orgs/${encodeURIComponent(this.org)}`
  }

  async request(
    method: PPMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<PPResponse> {
    let res = await this.send(method, path, opts)
    let attempts = 0
    while (res.status === 429 && attempts < MAX_RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_BACKOFF_MS)
      res = await this.send(method, path, opts)
      attempts++
    }
    return res
  }

  private async send(
    method: PPMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<PPResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      'X-User': this.auth.user,
      'X-Password': this.auth.password,
      Accept: 'application/json',
    }
    // A JSON Content-Type on a bodyless request makes some gateways 400; only set
    // it when there is a body to send.
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

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
}

/**
 * Build a client from the connection endpoint / component hostname (the Essentials
 * stack host), a credential and settings. Non-union: returns either { client, ... }
 * or { error }. Resolves the stack host from (in order) the endpoint/hostname, the
 * `stack_host` setting, then the us1 default.
 */
export function buildPPClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: PPClient; baseUrl: string; orgDomain: string } | { error: string } {
  const { auth, error } = resolvePPAuth(credential)
  if (!auth) return { error: error ?? MISSING_CREDENTIAL_MESSAGE }

  const resolved = readPPSettings(settings)
  if (!resolved.orgDomain) return { error: MISSING_ORG_MESSAGE }

  const host = hostname && hostname.trim() ? normalizeHost(hostname) : resolved.stackHost
  const baseUrl = `https://${host}/api/v1`

  return {
    client: new PPClient({ baseUrl, auth, org: resolved.orgDomain, timeoutMs: resolved.timeoutMs }),
    baseUrl,
    orgDomain: resolved.orgDomain,
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

/**
 * Essentials endpoints return either a bare array or an envelope like
 * `{ data: [...] }` / `{ domains: [...] }` / `{ users: [...] }`. Normalize any of
 * those to a plain array, or [] when the shape is unrecognized.
 */
export function asArray<T>(body: string, ...keys: string[]): T[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as T[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of ['data', ...keys]) {
      if (Array.isArray(obj[key])) return obj[key] as T[]
    }
  }
  return []
}

/** Extract a human-readable error from an Essentials error body. */
export function ppErrorMessage(res: PPResponse): string {
  const parsed = parseJson<Record<string, unknown>>(res.body)
  if (parsed && typeof parsed === 'object') {
    const msg = parsed.message ?? parsed.error ?? parsed.detail ?? parsed.errors
    if (typeof msg === 'string' && msg.trim()) return msg
    if (Array.isArray(msg) && msg.length > 0) {
      return msg.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ')
    }
  }
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}

/** Classify a thrown fetch/network error into a friendly message. */
export function classifyNetworkError(err: unknown, target: string): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/abort|timed?\s?out/i.test(msg)) return `Timed out reaching Proofpoint Essentials at ${target}. Check the stack host and network reachability.`
  if (/ENOTFOUND|getaddrinfo|dns/i.test(msg)) return `Could not resolve ${target}. Check the Essentials stack host (e.g. us1.proofpointessentials.com).`
  if (/ECONNREFUSED/i.test(msg)) return `Connection refused by ${target}.`
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg)) return `TLS/certificate error reaching ${target}: ${msg}`
  return `Could not reach Proofpoint Essentials (${target}): ${msg}`
}
