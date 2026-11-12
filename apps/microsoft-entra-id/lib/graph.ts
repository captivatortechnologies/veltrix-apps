// App-only Microsoft Graph client with tenant-bound secret, certificate, or host-broker
// authentication. Authority, audience, v1.0 requests and pagination are restricted
// to the selected Microsoft cloud. Tokens are cached per client instance.
// Read transport errors retry once; uncertain mutations never retry blindly.
// HTTP 429 retries once with a bounded wait. Redirects are refused.

import { constants, createPrivateKey, randomUUID, sign, X509Certificate } from 'node:crypto'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RATE_LIMIT_WAIT_MS = 20_000
/** Refresh the token this many ms before its stated expiry. */
const TOKEN_SKEW_MS = 60_000

export interface GraphIdentity {
  getAccessToken(opts: { tenantId: string; resource: string; cloud?: string }): Promise<string>
}

export interface GraphSettings {
  timeoutMs: number
  tenantId: string | null
  cloud?: string
  connections?: Record<string, { tenantId: string; cloud?: string }>
  configurationError?: string
}

export function readGraphSettings(settings: Record<string, unknown>): GraphSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawTenant = settings.tenant_id
  const tenantId = typeof rawTenant === 'string' && rawTenant.trim() ? rawTenant.trim() : null
  const connections = typeof settings.connection_tenants === 'object' ? settings.connection_tenants
    : parseJson<unknown>(String(settings.connection_tenants ?? '{}'))
  const valid = connections && typeof connections === 'object' && !Array.isArray(connections) &&
    Object.values(connections).every(value => value && typeof value === 'object' &&
      typeof (value as { tenantId?: unknown }).tenantId === 'string' &&
      !!(value as { tenantId: string }).tenantId.trim() &&
      ((value as { cloud?: unknown }).cloud === undefined || typeof (value as { cloud?: unknown }).cloud === 'string'))
  return { timeoutMs, tenantId, configurationError: valid ? undefined : 'Invalid per-connection tenant overrides', cloud: typeof settings.azure_cloud === 'string' ? settings.azure_cloud : 'global',
    connections: valid ? connections as GraphSettings['connections'] : {} }
}

export interface GraphCredential {
  tenantId: string
  clientId: string
  clientSecret: string
  certificate?: string
  cloud?: string
  identity?: GraphIdentity
}

/**
 * Resolve the Entra app-registration credential. Returns null if any of the
 * three required parts is missing so callers can surface MISSING_CREDENTIAL_MESSAGE.
 */
export function resolveGraphCredential(
  credential: CredentialRef | null,
  settings: GraphSettings,
  identity?: GraphIdentity,
): GraphCredential | null {
  if (!credential || settings.configurationError) return null
  const clientId = (credential.username ?? '').trim()
  const clientSecret = (credential.password || credential.apiToken || '').trim()
  const override = settings.connections?.[credential.id]
  const tenantId = (override?.tenantId ?? settings.tenantId ?? '').trim()
  if ((!clientId && !identity) || (!clientSecret && !credential.certificate && !identity) || !tenantId) return null
  return { tenantId, clientId, clientSecret, certificate: credential.certificate ?? undefined,
    cloud: override?.cloud ?? settings.cloud ?? 'global', identity }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Microsoft Entra credential — this app authenticates as an Entra app ' +
  'registration via OAuth2 client credentials. Store the application (client) ID in the ' +
  'credential "username" field and a client secret in "password" or "apiToken" (or a PEM certificate/private key in "certificate"), and set the directory ' +
  '(tenant) ID in the app\'s "Tenant ID" setting. The app registration needs the Graph ' +
  'application permissions for what this app manages (e.g. Policy.ReadWrite.ConditionalAccess, ' +
  'Group.ReadWrite.All), granted admin consent.'

export interface GraphResponse {
  status: number
  ok: boolean
  body: string
  /** `@odata.nextLink` from the JSON body, when the collection is paginated. */
  nextUrl: string | null
  uncertain?: boolean
  stage?: 'authentication' | 'request' | 'configuration'
}

export type GraphMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export const GRAPH_CLOUDS: Record<string, { login: string; graph: string }> = {
  global: { login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com' },
  'us-gov': { login: 'https://login.microsoftonline.us', graph: 'https://graph.microsoft.us' },
  'us-gov-dod': { login: 'https://login.microsoftonline.us', graph: 'https://dod-graph.microsoft.us' },
  china: { login: 'https://login.chinacloudapi.cn', graph: 'https://microsoftgraph.chinacloudapi.cn' },
}

/** Vault certificate field: PEM certificate and matching PEM private key. */
export function certificateAssertion(pem: string, clientId: string, audience: string): string {
  const cert = new X509Certificate(pem)
  const key = createPrivateKey(pem)
  if (!cert.checkPrivateKey(key)) throw new Error('Certificate and private key do not match')
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'PS256', typ: 'JWT',
    'x5t#S256': Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex').toString('base64url') })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ aud: audience, iss: clientId, sub: clientId,
    jti: randomUUID(), nbf: now - 30, exp: now + 300 })).toString('base64url')
  const input = `${header}.${payload}`
  return `${input}.${sign('sha256', Buffer.from(input), { key,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url')}`
}

export class GraphClient {
  private readonly cred: GraphCredential
  private readonly timeoutMs: number
  private token: string | null = null
  private tokenExpiresAt = 0

  constructor(opts: { cred: GraphCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  /** Acquire (and cache) a bearer token. Returns an error string on failure. */
  private async ensureToken(): Promise<{ token?: string; error?: string }> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_SKEW_MS) {
      return { token: this.token }
    }
    const cloud = (Object.prototype.hasOwnProperty.call(GRAPH_CLOUDS, this.cred.cloud ?? 'global') ? GRAPH_CLOUDS[this.cred.cloud ?? 'global'] : undefined)
    if (!cloud) return { error: 'Unsupported Microsoft cloud; choose global, us-gov, us-gov-dod, or china' }
    if (this.cred.identity && !this.cred.clientSecret && !this.cred.certificate) {
      try { return { token: await this.cred.identity.getAccessToken({ tenantId: this.cred.tenantId, resource: cloud.graph, cloud: this.cred.cloud }) } }
      catch { return { error: 'Platform identity broker could not acquire a token' } }
    }
    const url = `${cloud.login}/${encodeURIComponent(this.cred.tenantId)}/oauth2/v2.0/token`
    const form = new URLSearchParams({
      client_id: this.cred.clientId,
      scope: `${cloud.graph}/.default`,
      grant_type: 'client_credentials',
    })
    try {
      if (this.cred.certificate) {
        form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
        form.set('client_assertion', certificateAssertion(this.cred.certificate, this.cred.clientId, url))
      } else form.set('client_secret', this.cred.clientSecret)
    } catch { return { error: 'Invalid certificate credential: expected matching PEM certificate and private key' } }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
          redirect: 'error',
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

  /** Make a Graph request. `path` is either an absolute URL (e.g. a nextLink) or a
   *  `/v1.0`-relative path like `/identity/conditionalAccess/policies`. `opts.headers`
   *  merges over (and can override) the default headers — e.g. the `Accept-Language`
   *  header the organizational-branding default-locale PUT requires. */
  async request(
    method: GraphMethod,
    path: string,
    body?: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<GraphResponse> {
    const cloud = (Object.prototype.hasOwnProperty.call(GRAPH_CLOUDS, this.cred.cloud ?? 'global') ? GRAPH_CLOUDS[this.cred.cloud ?? 'global'] : undefined)
    let url: string
    try {
      if (!cloud) throw new Error('Unsupported Microsoft cloud')
      const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path)
      const parsed = new URL(absolute ? path : `${cloud.graph}/v1.0/${path.replace(/^\//, '')}`)
      if (parsed.origin !== cloud.graph || parsed.username || parsed.password || parsed.hash ||
          !parsed.pathname.startsWith('/v1.0/')) throw new Error('Graph URL must use the selected cloud origin and v1.0 API')
      url = absolute ? path : `${cloud.graph}/v1.0/${path.replace(/^\//, '')}`
    } catch (err) {
      return { status: 0, ok: false, body: err instanceof Error ? err.message : 'Invalid Graph URL', nextUrl: null, stage: 'configuration' }
    }
    const auth = await this.ensureToken()
    if (auth.error || !auth.token) {
      return { status: 0, ok: false, body: auth.error ?? 'no token', nextUrl: null, stage: 'authentication' }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(opts?.headers ?? {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body, (key, value) => key === '@odata.id' && typeof value === 'string'
            ? value.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0\//, `${cloud!.graph}/v1.0/`) : value),
          signal: controller.signal,
          redirect: 'error',
        })
        const text = await res.text()

        // Retry once on 429, honoring Retry-After (seconds), capped.
        if (res.status === 429 && attempt === 0) {
          const retryAfter = Number(res.headers.get('Retry-After'))
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_RATE_LIMIT_WAIT_MS)
            : 1000
          await sleep(waitMs)
          continue
        }

        let nextUrl: string | null = null
        const parsed = parseJson<{ '@odata.nextLink'?: string }>(text)
        if (parsed && typeof parsed['@odata.nextLink'] === 'string') {
          nextUrl = parsed['@odata.nextLink']
        }
        return { status: res.status, ok: res.ok, body: text, nextUrl }
      } catch (err) {
        if (method === 'GET' && attempt === 0) continue
        return {
          status: 0,
          ok: false,
          body: method === 'GET' ? (err instanceof Error ? err.message : 'request error')
            : 'Mutation outcome uncertain after transport failure. Inspect live state and reconcile stable IDs before retrying.',
          nextUrl: null, uncertain: method !== 'GET', stage: 'request',
        }
      } finally {
        clearTimeout(timer)
      }
    }
    return { status: 0, ok: false, body: 'request failed', nextUrl: null }
  }

  get(path: string): Promise<GraphResponse> {
    return this.request('GET', path)
  }
  post(path: string, body: unknown): Promise<GraphResponse> {
    return this.request('POST', path, body)
  }
  patch(path: string, body: unknown): Promise<GraphResponse> {
    return this.request('PATCH', path, body)
  }
  put(path: string, body: unknown, opts?: { headers?: Record<string, string> }): Promise<GraphResponse> {
    return this.request('PUT', path, body, opts)
  }
  delete(path: string): Promise<GraphResponse> {
    return this.request('DELETE', path)
  }

  /**
   * GET a collection following `@odata.nextLink` pagination.
   *
   * `truncated` is true when the page budget ran out while more pages remained —
   * i.e. the returned `items` is an INCOMPLETE view of the collection. Callers that
   * infer "declared object is absent" from a full listing MUST NOT treat a missing
   * item as absent when `truncated` is set (it may simply be on an unfetched page),
   * or they raise false "absent" drift / create duplicates. The cap bounds latency;
   * at Graph's default page size it now covers ~10k objects before truncating.
   */
  async getAll<T = unknown>(
    path: string,
    maxPages = 100,
  ): Promise<{ ok: boolean; items: T[]; truncated: boolean; lastError?: GraphResponse }> {
    const items: T[] = []
    let next: string | null = path
    let page = 0
    for (; page < maxPages && next; page++) {
      const res: GraphResponse = await this.get(next)
      if (!res.ok) return { ok: false, items, truncated: false, lastError: res }
      const parsed = parseJson<{ value?: T[]; '@odata.nextLink'?: string }>(res.body)
      if (!Array.isArray(parsed?.value)) return { ok: false, items, truncated: false,
        lastError: { ...res, ok: false, body: 'Invalid Graph collection response: expected value array' } }
      items.push(...parsed.value)
      next = res.nextUrl
    }
    // Stopped because the page budget ran out with a nextLink still pending.
    return { ok: true, items, truncated: next !== null }
  }
}

export function buildGraphClient(cred: GraphCredential, settings: GraphSettings): GraphClient {
  return new GraphClient({ cred, timeoutMs: settings.timeoutMs })
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Extract a human-readable message from a Graph error response body. */
export function graphErrorMessage(resp: GraphResponse): string {
  const parsed = parseJson<{ error?: { message?: string; code?: string } }>(resp.body)
  if (parsed?.error?.message) {
    return parsed.error.code ? `${parsed.error.code}: ${parsed.error.message}` : parsed.error.message
  }
  return resp.body?.slice(0, 300) || `Graph request failed (status ${resp.status})`
}
