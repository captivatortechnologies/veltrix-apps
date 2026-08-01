// =============================================================================
// JumpCloud REST API client.
//
// Auth is a JumpCloud API key sent on every request as the `x-api-key` header
// (NOT a Bearer token). Multi-tenant (MTP) admins additionally scope the request
// to a single organization with the `x-org-id` header — carried here from the
// connection credential's username (blank for single-tenant admins).
//
// Base URL is FIXED — JumpCloud is a single global console:
//   v1: https://console.jumpcloud.com/api
//   v2: https://console.jumpcloud.com/api/v2   (User Groups live here)
// This client targets v2; User Groups list responses are bare JSON arrays paged
// with `limit` + `skip`.
//
// Handlers run in-process in the platform's Node runtime, so this uses fetch with
// an AbortController timeout and no external HTTP dependency. It never throws on
// an HTTP error status — callers inspect `status` so they can tell a 404 (object
// absent) from a real failure.
//
// Sources (verify body fields against a live JumpCloud):
//   https://jumpcloud.com/support/jumpcloud-apis
//   https://jumpcloud.com/support/retrieve-object-ids-from-the-api
//   https://github.com/TheJumpCloud/jcapi-python/blob/master/jcapiv2/docs/UserGroupsApi.md
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** v1 base — fixed. */
export const JUMPCLOUD_API_BASE = 'https://console.jumpcloud.com/api'
/** v2 base — fixed. User Groups (/usergroups) live here. */
export const JUMPCLOUD_API_V2_BASE = 'https://console.jumpcloud.com/api/v2'

const REQUEST_TIMEOUT_MS = 30_000
/** JumpCloud v2 caps a list page at 100. */
export const PAGE_LIMIT = 100

export const MISSING_CREDENTIAL_MESSAGE =
  'No JumpCloud API key available — store a JumpCloud API key in the credential "API token" field. ' +
  'Generate one in the JumpCloud Admin Portal under your account name → "My API Key". The key ' +
  'inherits the permissions of the admin who owns it.'

/** Extract the JumpCloud API key from a Veltrix credential (apiToken preferred, password fallback). */
export function resolveApiKey(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const key = (credential.apiToken ?? credential.password ?? '').trim()
  return key.length > 0 ? key : null
}

/**
 * Optional org id for multi-tenant (MTP) admins, sent as `x-org-id`. Carried on
 * the connection credential's username — blank for single-tenant admins, who
 * must NOT send the header.
 */
export function resolveOrgId(credential: CredentialRef | null): string | null {
  const orgId = (credential?.username ?? '').trim()
  return orgId.length > 0 ? orgId : null
}

/** Resolve the per-request timeout from app settings (seconds → ms). */
export function readTimeoutMs(settings: Record<string, unknown>): number {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : REQUEST_TIMEOUT_MS
}

export interface JumpCloudResponse {
  status: number
  ok: boolean
  body: string
}

export type JumpCloudMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export class JumpCloudClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly orgId: string | null
  private readonly timeoutMs: number

  constructor(opts: { apiKey: string; orgId?: string | null; timeoutMs?: number; baseUrl?: string }) {
    this.baseUrl = (opts.baseUrl ?? JUMPCLOUD_API_V2_BASE).replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.orgId = opts.orgId ?? null
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.orgId) headers['x-org-id'] = this.orgId
    return headers
  }

  async request(
    method: JumpCloudMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<JumpCloudResponse> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: this.headers(),
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
   * GET every page of a v2 list endpoint, following `limit` + `skip` pagination,
   * and return the concatenated JSON arrays. Stops on the first error.
   */
  async listAll<T = unknown>(
    path: string,
  ): Promise<{ ok: boolean; items: T[]; status: number; body: string }> {
    const items: T[] = []
    let skip = 0
    let lastStatus = 0
    let lastBody = ''
    // Hard cap the walk so a misbehaving endpoint can never loop forever.
    for (let page = 0; page < 1000; page++) {
      const res = await this.request('GET', path, { query: { limit: PAGE_LIMIT, skip } })
      lastStatus = res.status
      lastBody = res.body
      if (!res.ok) return { ok: false, items, status: res.status, body: res.body }
      const rows = parseJson<T[]>(res.body)
      if (!Array.isArray(rows) || rows.length === 0) break
      items.push(...rows)
      if (rows.length < PAGE_LIMIT) break
      skip += PAGE_LIMIT
    }
    return { ok: true, items, status: lastStatus, body: lastBody }
  }
}

/** Build a client from a credential and app settings. */
export function buildJumpCloudClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: JumpCloudClient } | { error: string } {
  const apiKey = resolveApiKey(credential)
  if (!apiKey) return { error: MISSING_CREDENTIAL_MESSAGE }
  return {
    client: new JumpCloudClient({
      apiKey,
      orgId: resolveOrgId(credential),
      timeoutMs: readTimeoutMs(settings),
    }),
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

/** Extract a human-readable error from a JumpCloud error response body. */
export function jumpCloudErrorMessage(res: JumpCloudResponse): string {
  const parsed = parseJson<{ message?: string; error?: string }>(res.body)
  return parsed?.message || parsed?.error || res.body || `HTTP ${res.status}`
}
