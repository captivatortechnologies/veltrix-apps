// =============================================================================
// Fortinet FortiManager JSON-RPC API client.
//
// FortiManager exposes a single JSON-RPC endpoint — POST https://<host>/jsonrpc —
// where the `url` INSIDE the JSON body selects the resource, not the HTTP path.
// Auth is a session login:
//   exec sys/login/user { data:[{user,passwd}] } -> a `session` token used on
//   every subsequent call; exec sys/logout ends it.
//
// Convention for the Veltrix credential:
//   username -> FortiManager admin user
//   password -> that user's password
//   host     -> the `host` app setting (FMG hostname / URL)
//
// Config objects live under an ADOM, e.g.
//   /pm/config/adom/<adom>/obj/firewall/address   (mkey = object `name`).
// CRUD maps to the JSON-RPC `method`: get (list), add (create-only), set
// (create-or-replace upsert), delete. HTTP is almost always 200 even on logical
// failure — callers inspect result[].status.code (0 = OK). If the ADOM is in
// workspace mode, writes must be wrapped in workspace lock/commit/unlock.
//
// NOTE: this uses the standard fetch TLS stack, so the FortiManager must present
// a certificate the host trusts (a valid CA chain or FortiManager Cloud).
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000
/** FortiManager returns this code for an expired/invalid session (and for genuine
 *  permission errors) — we re-login once on it. */
const NO_PERMISSION_CODE = -11

export interface FmgSettings {
  timeoutMs: number
  /** Fully-resolved base, e.g. https://fmg.example.com (no trailing slash). */
  baseUrl: string | null
  adom: string
  workspaceMode: boolean
}

export function readFmgSettings(settings: Record<string, unknown>): FmgSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS
  const rawHost = settings.host
  let baseUrl: string | null = null
  if (typeof rawHost === 'string' && rawHost.trim()) {
    const h = rawHost.trim().replace(/\/+$/, '')
    baseUrl = /^https?:\/\//.test(h) ? h : `https://${h}`
  }
  const rawAdom = settings.adom
  const adom = typeof rawAdom === 'string' && rawAdom.trim() ? rawAdom.trim() : 'root'
  return { timeoutMs, baseUrl, adom, workspaceMode: settings.workspace_mode === true }
}

export interface FmgCredential {
  baseUrl: string
  user: string
  passwd: string
}

export function resolveFmgCredential(
  credential: CredentialRef | null,
  settings: FmgSettings
): FmgCredential | null {
  if (!credential) return null
  const user = (credential.username ?? '').trim()
  const passwd = credential.password ?? ''
  const baseUrl = (settings.baseUrl ?? '').trim()
  if (!user || !passwd || !baseUrl) return null
  return { baseUrl, user, passwd }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable FortiManager credential — this app authenticates with a FortiManager admin user via ' +
  'the JSON-RPC login. Store the username in the credential "username" field and the password in ' +
  '"password", and set the FortiManager host in the app\'s "Host" setting. The user needs read/write ' +
  'permission on the ADOM object database.'

export interface FmgResult {
  ok: boolean
  /** status.code from the first result element (0 = OK). */
  code: number
  message: string
  data: unknown
  /** set when the transport (not FMG) failed. */
  transportError?: string
}

/** Convert an object path to an ADOM-scoped firewall path, etc. Callers pass the
 *  full `url` already; this is just the JSON-RPC element type. */
interface RpcParam {
  url: string
  data?: unknown
  filter?: unknown
  option?: unknown
  confirm?: number
}

export class FmgClient {
  private readonly cred: FmgCredential
  private readonly timeoutMs: number
  private session: string | null = null

  constructor(opts: { cred: FmgCredential; timeoutMs: number }) {
    this.cred = opts.cred
    this.timeoutMs = opts.timeoutMs
  }

  /** POST a raw JSON-RPC body to /jsonrpc and return the parsed first result. */
  private async post(method: string, param: RpcParam, session: string | null): Promise<FmgResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.cred.baseUrl}/jsonrpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id: 1, method, params: [param], session }),
        signal: controller.signal,
      })
      const text = await res.text()
      const parsed = parseJson<{ result?: Array<{ status?: { code?: number; message?: string }; data?: unknown }>; session?: string }>(text)
      if (parsed?.session) this.session = parsed.session
      const r0 = parsed?.result?.[0]
      const code = r0?.status?.code ?? -1
      return {
        ok: code === 0,
        code,
        message: r0?.status?.message ?? (code === 0 ? 'OK' : 'unknown error'),
        data: r0?.data,
      }
    } catch (err) {
      return { ok: false, code: -1, message: 'transport error', data: null, transportError: err instanceof Error ? err.message : 'request error' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Log in and cache the session token. Returns an error string on failure. */
  private async login(): Promise<{ error?: string }> {
    const res = await this.post('exec', { url: 'sys/login/user', data: [{ user: this.cred.user, passwd: this.cred.passwd }] }, null)
    if (!res.ok || !this.session) {
      return { error: res.transportError ?? `login failed (${res.code}): ${res.message}` }
    }
    return {}
  }

  private async ensureSession(): Promise<{ error?: string }> {
    if (this.session) return {}
    return this.login()
  }

  /** Make a JSON-RPC call, re-logging in once if the session has expired. */
  async rpc(method: string, param: RpcParam): Promise<FmgResult> {
    const auth = await this.ensureSession()
    if (auth.error) return { ok: false, code: -1, message: auth.error, data: null, transportError: auth.error }

    let res = await this.post(method, param, this.session)
    if (res.code === NO_PERMISSION_CODE) {
      // Could be an expired session — re-login once and retry.
      this.session = null
      const relogin = await this.ensureSession()
      if (!relogin.error) res = await this.post(method, param, this.session)
    }
    return res
  }

  get(url: string, filter?: unknown): Promise<FmgResult> {
    return this.rpc('get', filter === undefined ? { url } : { url, filter })
  }
  add(url: string, data: unknown): Promise<FmgResult> {
    return this.rpc('add', { url, data })
  }
  /** create-or-replace (upsert). */
  set(url: string, data: unknown): Promise<FmgResult> {
    return this.rpc('set', { url, data })
  }
  delete(url: string, filter: unknown): Promise<FmgResult> {
    return this.rpc('delete', { url, filter, option: 'force', confirm: 1 })
  }
  exec(url: string): Promise<FmgResult> {
    return this.rpc('exec', { url })
  }

  // --- ADOM workspace transaction (only when workspace mode is enabled) -------
  lock(adom: string): Promise<FmgResult> {
    return this.exec(`/dvmdb/adom/${adom}/workspace/lock`)
  }
  commit(adom: string): Promise<FmgResult> {
    return this.exec(`/dvmdb/adom/${adom}/workspace/commit`)
  }
  unlock(adom: string): Promise<FmgResult> {
    return this.exec(`/dvmdb/adom/${adom}/workspace/unlock`)
  }

  async logout(): Promise<void> {
    if (this.session) {
      await this.post('exec', { url: 'sys/logout' }, this.session)
      this.session = null
    }
  }
}

export function buildFmgClient(cred: FmgCredential, settings: FmgSettings): FmgClient {
  return new FmgClient({ cred, timeoutMs: settings.timeoutMs })
}

/** The ADOM-scoped firewall address object path. */
export function addressUrl(adom: string): string {
  return `/pm/config/adom/${adom}/obj/firewall/address`
}

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

export function fmgErrorMessage(res: FmgResult): string {
  if (res.transportError) return res.transportError
  return res.code === 0 ? 'OK' : `${res.message} (code ${res.code})`
}
