// =============================================================================
// Check Point Management API client — session + publish/discard model.
//
// Base: https://<mgmt-server>[:port]/web_api/<command> — unversioned by
// default (a version segment, /web_api/v<version>/<command>, is optional and
// only needed to pin an older API revision; omitted, the server serves its
// own default/latest installed version).
//   Reference: https://sc1.checkpoint.com/documents/latest/APIs/ (Management API)
//
// Session lifecycle — verified against Check Point's own Management API
// Python SDK (github.com/CheckPointSW/cp_mgmt_api_python_sdk, cpapi/mgmt_api.py
// + cpapi/api_response.py):
//   POST /web_api/login   { user, password } | { api-key }  -> { sid, api-server-version }
//   ...every other command...  header  X-chkp-sid: <sid>
//   POST /web_api/publish  {}   commits this session's changes to the database
//   POST /web_api/discard  {}   throws away this session's uncommitted changes
//   POST /web_api/logout   {}   ends the session
// Success is HTTP 200 exactly; any other status is a failure, with detail in
// the JSON body (commonly `message` / `code`, sometimes `warnings` / `errors`).
// A session is meant to be ONE unit of work — login, act, publish-or-discard,
// logout — not a long-lived cached connection, so this client does not cache
// or reuse sessions across handler invocations.
//
// Host object commands used by the network-hosts config type — verified
// against Check Point's own Ansible collection
// (github.com/CheckPointSW/CheckPointAnsibleMgmtCollection,
// plugins/modules/cp_mgmt_host.py + cp_mgmt_host_facts.py) and Terraform
// provider (github.com/CheckPointSW/terraform-provider-checkpoint,
// checkpoint/resource_checkpoint_management_host.go): add-host / set-host /
// delete-host / show-host / show-hosts, identified by `name`, with body keys
// `ipv4-address`, `ipv6-address`, `comments`, `color`, `tags`.
//
// TLS: an on-prem Security Management Server ships a SELF-SIGNED certificate
// by default for web_api / SmartConsole — the same posture this codebase
// already handles for other self-hosted tools (MISP, Security Onion, Splunk).
// This client therefore talks node:https directly through an https.Agent
// whose rejectUnauthorized reflects the "Verify TLS certificate" setting
// (off by default) rather than the platform's global fetch.
// =============================================================================

import { Agent, request as httpsRequest } from 'node:https'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_PORT = 443
const REQUEST_TIMEOUT_MS = 30_000
/** Check Point's show-* commands cap a single page at 500 objects. */
export const MAX_PAGE_SIZE = 500

// --- Settings ----------------------------------------------------------------

export interface CheckpointSettings {
  port: number
  verifyTls: boolean
  domain: string | null
  timeoutMs: number
}

export function readCheckpointSettings(settings: Record<string, unknown>): CheckpointSettings {
  const rawPort = settings.port
  const port = typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 ? rawPort : DEFAULT_PORT

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  const rawDomain = settings.domain
  const domain = typeof rawDomain === 'string' && rawDomain.trim() ? rawDomain.trim() : null

  return { port, verifyTls: settings.verify_tls === true, domain, timeoutMs }
}

// --- Credentials ---------------------------------------------------------------

/** Either an API key or a username/password pair — Check Point login accepts either. */
export type CheckpointCredential = { apiKey: string } | { user: string; password: string }

/**
 * Resolve the Check Point login credential from a Veltrix credential: an API
 * key in `apiToken` takes priority (Check Point Object Explorer > New > API
 * Key, or `mgmt_cli add api-key`); otherwise `username` + `password`.
 */
export function resolveCheckpointCredential(credential: CredentialRef | null): CheckpointCredential | null {
  if (!credential) return null
  const apiKey = (credential.apiToken ?? '').trim()
  if (apiKey) return { apiKey }
  const user = (credential.username ?? '').trim()
  const password = credential.password ?? ''
  if (user && password) return { user, password }
  return null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Check Point credential — this app logs into the Management API with either an ' +
  'administrator username + password, or an API key. Store the username in the credential ' +
  '"username" field and password in "password", OR store an API key in the "API token" field ' +
  '(Check Point Object Explorer > New > API Key, or mgmt_cli add api-key).'

export const MISSING_HOST_MESSAGE =
  'No Check Point Management Server host — register a "checkpoint-management" component whose ' +
  'hostname is the same management server address you point SmartConsole at.'

// --- Transport -----------------------------------------------------------------

export interface CheckpointResult<T = unknown> {
  ok: boolean
  status: number
  data: T | null
  message: string
  transportError: string | null
}

/** Read a common { message, code, warnings[], errors[] } shape into one string. */
function extractMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return 'OK'
  const d = data as Record<string, unknown>
  const parts: string[] = []
  if (typeof d.message === 'string' && d.message) parts.push(d.message)
  if (typeof d.code === 'string' && d.code && d.code !== 'ok') parts.push(`(${d.code})`)
  for (const key of ['warnings', 'errors'] as const) {
    const list = d[key]
    if (Array.isArray(list)) {
      for (const entry of list) {
        const msg = (entry as Record<string, unknown> | undefined)?.message
        if (typeof msg === 'string' && msg) parts.push(`${key === 'warnings' ? 'warning' : 'error'}: ${msg}`)
      }
    }
  }
  return parts.length > 0 ? parts.join(' ') : 'OK'
}

export function checkpointErrorMessage(res: CheckpointResult): string {
  return res.transportError ?? res.message
}

/** True when a failed response looks like "the object doesn't exist" (safe to ignore on cleanup deletes). */
export function isNotFoundError(res: CheckpointResult): boolean {
  if (res.status === 404) return true
  const msg = res.message.toLowerCase()
  return /not exist|not found|no object/.test(msg)
}

function parseJson(body: string): unknown {
  try {
    return body ? JSON.parse(body) : null
  } catch {
    return null
  }
}

export class CheckpointClient {
  private readonly host: string
  private readonly port: number
  private readonly agent: Agent
  private readonly timeoutMs: number
  private readonly domain: string | null
  private readonly cred: CheckpointCredential
  private sid: string | null = null

  constructor(opts: {
    host: string
    port: number
    verifyTls: boolean
    timeoutMs: number
    domain: string | null
    cred: CheckpointCredential
  }) {
    this.host = opts.host
    this.port = opts.port
    this.timeoutMs = opts.timeoutMs
    this.domain = opts.domain
    this.cred = opts.cred
    // A dedicated Agent (not the platform's global fetch) so a self-signed
    // management certificate is tolerated only when this setting allows it.
    this.agent = new Agent({ rejectUnauthorized: opts.verifyTls, keepAlive: false })
  }

  /** One raw POST against /web_api/<command>, JSON in and out. Never throws. */
  private post<T = unknown>(command: string, body: Record<string, unknown>): Promise<CheckpointResult<T>> {
    return new Promise((resolve) => {
      const payload = JSON.stringify(body)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
      }
      if (this.sid) headers['X-chkp-sid'] = this.sid

      const req = httpsRequest(
        {
          hostname: this.host,
          port: this.port,
          path: `/web_api/${command}`,
          method: 'POST',
          headers,
          agent: this.agent,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            const data = parseJson(Buffer.concat(chunks).toString('utf8')) as T | null
            resolve({ ok: status === 200, status, data, message: extractMessage(data), transportError: null })
          })
        },
      )
      req.on('error', (err) => {
        resolve({ ok: false, status: 0, data: null, message: err.message, transportError: err.message })
      })
      req.on('timeout', () => {
        const reason = `Timed out after ${this.timeoutMs / 1000}s connecting to ${this.host}:${this.port}`
        req.destroy(new Error(reason))
        resolve({ ok: false, status: 0, data: null, message: reason, transportError: reason })
      })
      req.write(payload)
      req.end()
    })
  }

  /**
   * Log in and capture the session id (`sid`). `continue-last-session` is
   * deliberately omitted so every handler invocation opens its own isolated
   * session, matching the login → act → publish/discard → logout unit of work.
   */
  async login(): Promise<{ error: string | null }> {
    const body: Record<string, unknown> =
      'apiKey' in this.cred ? { 'api-key': this.cred.apiKey } : { user: this.cred.user, password: this.cred.password }
    if (this.domain) body.domain = this.domain

    const res = await this.post<{ sid?: string }>('login', body)
    if (res.transportError) return { error: res.transportError }
    if (!res.ok || !res.data?.sid) {
      return { error: `Check Point login failed: ${checkpointErrorMessage(res)}` }
    }
    this.sid = res.data.sid
    return { error: null }
  }

  /** Run one Management API command against the active session. */
  call<T = unknown>(command: string, body: Record<string, unknown> = {}): Promise<CheckpointResult<T>> {
    return this.post<T>(command, body)
  }

  /** Commit this session's changes to the management database. */
  publish(): Promise<CheckpointResult> {
    return this.post('publish', {})
  }

  /** Discard this session's uncommitted changes — call on any error before logout. */
  discard(): Promise<CheckpointResult> {
    return this.post('discard', {})
  }

  /** End the session. Safe to call even when login never succeeded. */
  async logout(): Promise<void> {
    if (!this.sid) return
    await this.post('logout', {})
    this.sid = null
  }
}

/** Build a client from a component hostname, a credential and settings. */
export function buildCheckpointClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: CheckpointClient; host: string } | { error: string } {
  const cred = resolveCheckpointCredential(credential)
  if (!cred) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = (hostname ?? '').trim()
  if (!host) return { error: MISSING_HOST_MESSAGE }

  const resolved = readCheckpointSettings(settings)
  return {
    client: new CheckpointClient({
      host,
      port: resolved.port,
      verifyTls: resolved.verifyTls,
      timeoutMs: resolved.timeoutMs,
      domain: resolved.domain,
      cred,
    }),
    host,
  }
}
