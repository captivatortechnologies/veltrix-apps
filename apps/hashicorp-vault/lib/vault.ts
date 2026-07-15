// =============================================================================
// HashiCorp Vault HTTP API client.
//
// Auth is a Vault token sent on every request as `X-Vault-Token`. All routes are
// under `/v1`. Vault treats POST and PUT as synonyms for writes, and returns
// EITHER 200 or 204 on success (204 = no body) — both are OK. Errors carry
// `{ "errors": [ ... ] }`.
//
// Handlers run in-process in the platform's Node runtime, so this uses fetch
// with an AbortController timeout and no external HTTP dependency. It never
// throws on an HTTP error status — callers inspect `status` so they can tell a
// 404 (path absent) from a real failure.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

export interface VaultSettings {
  namespace: string | null
  timeoutMs: number
}

/** Read and normalize the app settings that drive Vault access. */
export function readVaultSettings(settings: Record<string, unknown>): VaultSettings {
  const rawNs = settings.namespace
  const namespace =
    typeof rawNs === 'string' && rawNs.trim().length > 0 ? rawNs.trim().replace(/^\/+|\/+$/g, '') : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { namespace, timeoutMs }
}

/**
 * Extract the Vault token from a Veltrix credential.
 * Convention: the token in "API token" (preferred) or "password".
 */
export function resolveVaultToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Vault token available — store a Vault token in the credential "API token" field. The token ' +
  'must have a policy granting sudo on the sys/ paths this app manages (sys/policies/acl, sys/auth, ' +
  'sys/mounts, sys/audit).'

export interface VaultResponse {
  status: number
  ok: boolean
  body: string
}

export type VaultMethod = 'GET' | 'LIST' | 'POST' | 'PUT' | 'DELETE'

export class VaultClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly namespace: string | null
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; namespace: string | null; timeoutMs: number }) {
    // Normalize to `<scheme>://host:port/v1` — the client always speaks v1.
    const trimmed = opts.baseUrl.replace(/\/+$/, '')
    this.baseUrl = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
    this.token = opts.token
    this.namespace = opts.namespace
    this.timeoutMs = opts.timeoutMs
  }

  async request(
    method: VaultMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<VaultResponse> {
    // Vault has no LIST verb over plain fetch; it is GET with ?list=true.
    const isList = method === 'LIST'
    const httpMethod = isList ? 'GET' : method
    const url = new URL(`${this.baseUrl}${path}`)
    if (isList) url.searchParams.set('list', 'true')
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = {
      'X-Vault-Token': this.token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.namespace) headers['X-Vault-Namespace'] = this.namespace

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method: httpMethod,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const body = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from a component hostname, a credential and app settings. */
export function buildVaultClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: VaultClient; baseUrl: string } | { error: string } {
  const token = resolveVaultToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = hostname?.trim()
  if (!host) {
    return {
      error:
        'No Vault address — register a component whose hostname is the Vault URL ' +
        '(e.g. https://vault.example.com:8200).',
    }
  }

  const resolved = readVaultSettings(settings)
  const baseUrl = host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`

  return {
    client: new VaultClient({ baseUrl, token, namespace: resolved.namespace, timeoutMs: resolved.timeoutMs }),
    baseUrl,
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

/** Extract a human-readable error from a Vault error response body (`{errors:[]}`). */
export function vaultErrorMessage(res: VaultResponse): string {
  const parsed = parseJson<{ errors?: string[] }>(res.body)
  if (parsed?.errors && parsed.errors.length > 0) return parsed.errors.join('; ')
  return res.body || `HTTP ${res.status}`
}
