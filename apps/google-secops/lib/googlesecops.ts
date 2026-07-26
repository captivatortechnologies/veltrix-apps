// =============================================================================
// Google Security Operations (Chronicle) REST API client.
//
// Auth is a Google service account. The SA JSON key is exchanged for an access
// token via the JWT-bearer (RFC 7523) flow: a JWT is signed RS256 with the key's
// private_key and POSTed to the key's token_uri; the returned Bearer token is
// cached until ~1 min before expiry.
//
// Convention for the Veltrix credential:
//   password -> the whole service-account JSON key (contains the RSA private key)
//   settings -> region, project_id, instance_id (build the resource parent path)
//
// The API host is regionalized: us -> chronicle.googleapis.com, otherwise
// {region}-chronicle.googleapis.com. The parent for reference lists is
//   /v1alpha/projects/{project}/locations/{region}/instances/{instance}
// Reference lists CANNOT be deleted — "removing" one means PATCHing its entries
// to empty.
// =============================================================================

import { createSign } from 'node:crypto'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const TOKEN_SKEW_MS = 60_000

export interface SecOpsSettings {
  timeoutMs: number
  region: string
  projectId: string | null
  instanceId: string | null
}

export function readSecOpsSettings(settings: Record<string, unknown>): SecOpsSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const region = typeof settings.region === 'string' && settings.region.trim() ? settings.region.trim().toLowerCase() : 'us'
  const projectId = typeof settings.project_id === 'string' && settings.project_id.trim() ? settings.project_id.trim() : null
  const instanceId = typeof settings.instance_id === 'string' && settings.instance_id.trim() ? settings.instance_id.trim() : null
  return { timeoutMs, region, projectId, instanceId }
}

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri: string
}

export interface SecOpsCredential {
  key: ServiceAccountKey
  baseUrl: string
  parent: string
}

/** Regionalized API host: us -> chronicle.googleapis.com, else {region}-chronicle... */
export function regionBaseUrl(region: string): string {
  return region === 'us' ? 'https://chronicle.googleapis.com' : `https://${region}-chronicle.googleapis.com`
}

export function resolveSecOpsCredential(credential: CredentialRef | null, settings: SecOpsSettings): SecOpsCredential | null {
  if (!credential || !settings.projectId || !settings.instanceId) return null
  const raw = (credential.password ?? '').trim()
  if (!raw) return null
  const key = parseJson<Partial<ServiceAccountKey>>(raw)
  if (!key?.client_email || !key.private_key || !key.token_uri) return null
  const baseUrl = regionBaseUrl(settings.region)
  const parent = `/v1alpha/projects/${settings.projectId}/locations/${settings.region}/instances/${settings.instanceId}`
  return { key: key as ServiceAccountKey, baseUrl, parent }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Google SecOps credential — this app authenticates with a Google service account. Store ' +
  'the entire service-account JSON key in the credential "password" field, and set the region, ' +
  'project ID and instance ID in the app\'s settings. The service account needs the Chronicle API ' +
  'role for reference lists (cloud-platform scope).'

export interface SecOpsResponse {
  status: number
  ok: boolean
  body: string
  transportError?: string
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export class SecOpsClient {
  private readonly cred: SecOpsCredential
  private readonly timeoutMs: number
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(opts: { cred: SecOpsCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  /** Build + sign (RS256) a JWT assertion and exchange it for an access token. */
  private async ensureToken(): Promise<{ token?: string; error?: string }> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) return { token: this.token }
    const now = Math.floor(Date.now() / 1000)
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64url(
      JSON.stringify({ iss: this.cred.key.client_email, scope: SCOPE, aud: this.cred.key.token_uri, iat: now, exp: now + 3600 })
    )
    const signingInput = `${header}.${claims}`
    let assertion: string
    try {
      const signature = createSign('RSA-SHA256').update(signingInput).sign(this.cred.key.private_key)
      assertion = `${signingInput}.${base64url(signature)}`
    } catch (err) {
      return { error: err instanceof Error ? `JWT signing failed: ${err.message}` : 'JWT signing failed' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const form = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
      const res = await fetch(this.cred.key.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      })
      const body = await res.text()
      if (!res.ok) {
        const parsed = parseJson<{ error_description?: string; error?: string }>(body)
        return { error: parsed?.error_description || parsed?.error || `token request failed (${res.status})` }
      }
      const parsed = parseJson<{ access_token?: string; expires_in?: number }>(body)
      if (!parsed?.access_token) return { error: 'token response missing access_token' }
      this.token = parsed.access_token
      this.tokenExpiresAt = Date.now() + (parsed.expires_in ?? 3600) * 1000
      return { token: this.token }
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'token request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** `path` is appended to the API host; use `parent()` for the resource parent. */
  async request(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<SecOpsResponse> {
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) return { status: 0, ok: false, body: auth.error ?? 'no token', transportError: auth.error }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.cred.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.ok, body: text }
    } catch (err) {
      return { status: 0, ok: false, body: '', transportError: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  parent(): string {
    return this.cred.parent
  }
}

export function buildSecOpsClient(cred: SecOpsCredential, settings: SecOpsSettings): SecOpsClient {
  return new SecOpsClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function secopsErrorMessage(res: SecOpsResponse): string {
  if (res.transportError) return res.transportError
  const parsed = parseJson<{ error?: { message?: string; status?: string } }>(res.body)
  if (parsed?.error?.message) return parsed.error.status ? `${parsed.error.status}: ${parsed.error.message}` : parsed.error.message
  return res.body?.slice(0, 300) || `Google SecOps request failed (HTTP ${res.status})`
}
