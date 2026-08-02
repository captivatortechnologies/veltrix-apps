// =============================================================================
// OPNsense REST API client — HTTP Basic (API key + secret) transport with
// self-signed-TLS handling, plus the firewall/alias resource helpers.
//
// Base URL: https://<host>[:port]/api/<module>/<controller>/<command>[/<param>...]
//   Reference: https://docs.opnsense.org/development/api.html
//
// Auth — verified against OPNsense core's own request-dispatch source
// (github.com/opnsense/core, src/opnsense/mvc/app/controllers/OPNsense/Base/
// ApiControllerBase.php::beforeExecuteRoute): every request carries
// `Authorization: Basic base64(<api key>:<api secret>)` — the API key in the
// username position, the API secret in the password position. A key/secret
// pair is generated per OPNsense user (System > Access > Users > <user> >
// API keys) and downloaded once; OPNsense stores only its hash, so a lost
// secret means generating a new pair. Failure shapes (verified from the same
// source):
//   - missing/invalid Authorization                -> HTTP 401 { status: 401, message: "Authentication Failed" }
//   - authenticated but not privileged for the URI  -> HTTP 403 { status: 403, message: "Forbidden" }
//   - POST body sent without Content-Type: application/json, or malformed
//     JSON when that header IS set                  -> HTTP 400 { status: 400, message: "Invalid JSON syntax" }
//     (a non-JSON POST is simply never parsed into $_POST — the action then
//     behaves as if no body was sent at all, e.g. addItem returns
//     {"result":"failed"} with no validations, NOT an error response)
//
// TLS: an OPNsense box (physical or virtual firewall appliance the customer
// already runs) ships a SELF-SIGNED certificate for its GUI/API by default
// until an administrator installs a CA-signed one — the same posture this
// codebase already handles for Check Point, Cisco ISE, Security Onion, etc.
// This client talks node:https directly through a dedicated https.Agent whose
// rejectUnauthorized reflects the "Verify TLS certificate" setting (off by
// default) rather than the platform's global fetch.
// =============================================================================

import { Agent, request as httpsRequest } from 'node:https'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const DEFAULT_PORT = 443
const DEFAULT_TIMEOUT_MS = 30_000

// --- Settings ----------------------------------------------------------------

export interface OpnsenseSettings {
  verifyTls: boolean
  timeoutMs: number
}

export function readOpnsenseSettings(settings: Record<string, unknown>): OpnsenseSettings {
  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS
  return { verifyTls: settings.verify_tls === true, timeoutMs }
}

// --- Credentials ---------------------------------------------------------------

export interface OpnsenseCredential {
  key: string
  secret: string
}

/**
 * Resolve the OPNsense API key/secret pair from a Veltrix credential. The key
 * lives in `username`; the secret lives in either `password` (the
 * Connections form's "Username & password" auth method) or `apiToken` (its
 * "Username & API secret" method) — both map onto the same key/secret pair
 * server-side, so either form works identically against this client.
 */
export function resolveOpnsenseCredential(credential: CredentialRef | null): OpnsenseCredential | null {
  if (!credential) return null
  const key = (credential.username ?? '').trim()
  const secret = credential.password || credential.apiToken || ''
  if (!key || !secret) return null
  return { key, secret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable OPNsense API credential — generate a key/secret pair for an administrator ' +
  '(System > Access > Users > <user> > API keys) and store the KEY in the credential ' +
  '"username" field and the SECRET in "password" (or "API token").'

export const MISSING_HOST_MESSAGE =
  'No OPNsense host configured for this connection — register an "opnsense-firewall" component ' +
  'whose hostname is the same address the OPNsense GUI is reachable at.'

function basicAuthHeader(cred: OpnsenseCredential): string {
  return `Basic ${Buffer.from(`${cred.key}:${cred.secret}`, 'utf8').toString('base64')}`
}

// --- Transport -----------------------------------------------------------------

export interface OpnsenseResult<T = unknown> {
  ok: boolean
  status: number
  data: T | null
  message: string
  transportError: string | null
}

function parseJson(body: string): unknown {
  try {
    return body ? JSON.parse(body) : null
  } catch {
    return null
  }
}

/**
 * Read a human message out of whatever shape the response body took:
 *   - the auth-layer envelope `{ status, message }`
 *   - a mutable-model failure `{ result: "failed", validations: {...} }`
 *   - a bare `{ result: "..." }` / `{ status: "..." }`
 *   - otherwise, the raw (clipped) body text
 */
function extractMessage(data: unknown, status: number, rawBody: string): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (typeof d.message === 'string' && d.message) return d.message
    if (d.validations && typeof d.validations === 'object') {
      const parts = Object.entries(d.validations as Record<string, unknown>).map(
        ([field, msg]) => `${field}: ${Array.isArray(msg) ? msg.join('; ') : String(msg)}`,
      )
      if (parts.length > 0) return parts.join(' | ')
    }
    if (typeof d.status_msg === 'string' && d.status_msg) return d.status_msg
    if (typeof d.result === 'string' && d.result) return d.result
    if (typeof d.status === 'string' && d.status) return d.status
  }
  const trimmed = rawBody.replace(/\s+/g, ' ').trim()
  if (trimmed) return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed
  return `HTTP ${status}`
}

export function opnsenseErrorMessage(res: OpnsenseResult): string {
  return res.transportError ?? res.message
}

export class OpnsenseClient {
  private readonly host: string
  private readonly port: number
  private readonly agent: Agent
  private readonly timeoutMs: number
  private readonly authHeader: string

  constructor(opts: { host: string; port: number; verifyTls: boolean; timeoutMs: number; cred: OpnsenseCredential }) {
    this.host = opts.host
    this.port = opts.port
    this.timeoutMs = opts.timeoutMs
    this.authHeader = basicAuthHeader(opts.cred)
    // A dedicated Agent (not the platform's global fetch) so a self-signed
    // GUI/API certificate is tolerated only when this setting allows it.
    this.agent = new Agent({ rejectUnauthorized: opts.verifyTls, keepAlive: false })
  }

  /**
   * One request against /api/<segments...>. `body`, when present, is ALWAYS
   * sent as a JSON object (never omitted for a mutating call) — OPNsense only
   * parses a POST into $_POST when Content-Type is application/json
   * (ApiControllerBase::parseJsonBodyData). Never throws on an HTTP error
   * status; only network failures and timeouts resolve as a transportError.
   */
  request<T = unknown>(
    method: 'GET' | 'POST',
    segments: Array<string | number>,
    body?: Record<string, unknown>,
  ): Promise<OpnsenseResult<T>> {
    return new Promise((resolve) => {
      const path = `/api/${segments.map((s) => encodeURIComponent(String(s))).join('/')}`
      const payload = body !== undefined ? JSON.stringify(body) : ''
      const headers: Record<string, string> = { Authorization: this.authHeader, Accept: 'application/json' }
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(Buffer.byteLength(payload))
      }

      const req = httpsRequest(
        {
          hostname: this.host,
          port: this.port,
          path,
          method,
          headers,
          agent: this.agent,
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            const raw = Buffer.concat(chunks).toString('utf8')
            const data = parseJson(raw) as T | null
            resolve({
              ok: status >= 200 && status < 300,
              status,
              data,
              message: extractMessage(data, status, raw),
              transportError: null,
            })
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
      if (body !== undefined) req.write(payload)
      req.end()
    })
  }
}

/** Build a client from a component hostname/port, a credential and settings. */
export function buildOpnsenseClient(
  hostname: string | undefined,
  port: string | number | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: OpnsenseClient; host: string } | { error: string } {
  const cred = resolveOpnsenseCredential(credential)
  if (!cred) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = (hostname ?? '').trim()
  if (!host) return { error: MISSING_HOST_MESSAGE }

  const resolved = readOpnsenseSettings(settings)
  const resolvedPort = Number(port) > 0 ? Number(port) : DEFAULT_PORT
  return {
    client: new OpnsenseClient({
      host,
      port: resolvedPort,
      verifyTls: resolved.verifyTls,
      timeoutMs: resolved.timeoutMs,
      cred,
    }),
    host,
  }
}

// --- Firewall Alias resource (api/firewall/alias/*) ---------------------------
//
// Verified against OPNsense core's own source (github.com/opnsense/core):
//   controller: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/AliasController.php
//   base CRUD:  src/opnsense/mvc/app/controllers/OPNsense/Base/ApiMutableModelControllerBase.php
//   model:      src/opnsense/mvc/app/models/OPNsense/Firewall/Alias.xml
//   grid list:  src/opnsense/mvc/app/library/OPNsense/Base/UIModelGrid.php
//
// The model's "stage, then apply" split: addItem/setItem/delItem only write
// the pending configuration (config.xml in memory + on save); NOTHING takes
// effect on the running firewall until reconfigure runs `filter reload
// skip_alias`, `template reload OPNsense/Filter` and `filter refresh_aliases`.
// A deploy/rollback that stages N changes and never calls reconfigure has
// changed nothing a packet actually sees.

export const ALIAS_MODULE = ['firewall', 'alias'] as const

/**
 * Every non-container model field is set via BaseField::setValue(), which
 * does a PHP `(string)$value` cast — verified in
 * src/opnsense/mvc/app/models/OPNsense/Base/FieldTypes/BaseField.php. Sending
 * a JSON ARRAY for one of these fields does not "join" it: BaseModel::setNodes
 * explicitly THROWS ("Invalid input type for <field>: expected a single
 * value") the moment it sees `is_array($data[$key])` for a non-container
 * field. So every alias field below — including `content` (see
 * AliasContentField's `private $separatorchar = "\n"`) and the Multiple
 * option field `proto` — must be sent as ONE STRING, never an array. This
 * client only ever builds alias bodies as Record<string, string> to make
 * that mistake structurally impossible.
 */
export interface AliasBody {
  enabled: string // "1" | "0"
  name: string
  type: string
  content: string // entries joined with "\n"
  description: string
  proto: string // "IPv4" | "IPv6" | "IPv4,IPv6" | ""
  interface: string
  updatefreq: string // numeric string, or "" when unset
}

/** A firewall alias exactly as `searchItem` returns it — flat field values (UIModelGrid::fetch). */
export interface LiveAlias {
  uuid: string
  enabled?: string
  name?: string
  type?: string
  content?: string
  description?: string
  proto?: string
  interface?: string
  updatefreq?: string
  [key: string]: unknown
}

interface SearchItemResponse {
  rows?: LiveAlias[]
  rowCount?: number
  total?: number
  current?: number
}

/**
 * List every configured alias. `GET|POST /api/firewall/alias/searchItem`.
 * The server defaults `rowCount` to `-1` ("all results", one page —
 * UIModelGrid::fetchBindRequest/fetch) whenever it is omitted, so a bare call
 * with no query params already returns the complete set: no pagination loop
 * needed, unlike a tool whose list endpoint hard-caps a page size.
 */
export async function searchAliases(client: OpnsenseClient): Promise<LiveAlias[]> {
  const res = await client.request<SearchItemResponse>('GET', [...ALIAS_MODULE, 'searchItem'])
  if (!res.ok) throw new Error(`searchItem failed: ${opnsenseErrorMessage(res)}`)
  return res.data?.rows ?? []
}

interface MutateResponse {
  result?: string
  uuid?: string
  validations?: Record<string, unknown>
}

/** `POST /api/firewall/alias/addItem` — body `{ alias: {...} }`. Returns the new uuid. */
export async function addAlias(client: OpnsenseClient, body: AliasBody): Promise<string> {
  const res = await client.request<MutateResponse>('POST', [...ALIAS_MODULE, 'addItem'], { alias: body })
  if (res.data?.result === 'saved' && res.data.uuid) return res.data.uuid
  throw new Error(`addItem "${body.name}" was not saved: ${opnsenseErrorMessage(res)}`)
}

/**
 * `POST /api/firewall/alias/setItem/<uuid>` — body `{ alias: {...} }`. Note:
 * setBase() only overwrites the keys present in the body (a merge against the
 * existing node, not a full replace) — this client always sends every
 * managed field (AliasBody has none optional) so a value the canvas cleared
 * is genuinely cleared, not left stale.
 */
export async function setAlias(client: OpnsenseClient, uuid: string, body: AliasBody): Promise<void> {
  const res = await client.request<MutateResponse>('POST', [...ALIAS_MODULE, 'setItem', uuid], { alias: body })
  if (res.data?.result === 'saved') return
  throw new Error(`setItem "${uuid}" (${body.name}) failed: ${opnsenseErrorMessage(res)}`)
}

/**
 * `POST /api/firewall/alias/delItem/<uuid>`. AliasController::delItemAction
 * checks `whereUsed()` first and throws ("Alias in use") if another alias or
 * a firewall/NAT rule still references this one by name — that failure
 * surfaces here as a thrown Error whose message names the blocker.
 */
export async function deleteAlias(client: OpnsenseClient, uuid: string): Promise<void> {
  const res = await client.request<MutateResponse>('POST', [...ALIAS_MODULE, 'delItem', uuid])
  if (res.data?.result === 'deleted' || res.data?.result === 'not found') return
  throw new Error(`delItem "${uuid}" failed: ${opnsenseErrorMessage(res)}`)
}

/**
 * `POST /api/firewall/alias/reconfigure` — the APPLY step described in the
 * module doc above. Every deploy/rollback that staged at least one
 * add/set/delItem call MUST call this once, after every stage call, before
 * reporting success — otherwise the staged changes sit in the pending
 * configuration and never reach the running pf ruleset.
 */
export async function reconfigureAliases(client: OpnsenseClient): Promise<void> {
  const res = await client.request<{ status?: string }>('POST', [...ALIAS_MODULE, 'reconfigure'])
  if (res.data?.status === 'ok') return
  throw new Error(`reconfigure failed — staged alias changes were NOT applied: ${opnsenseErrorMessage(res)}`)
}

// --- Connectivity probe (api/core/firmware/status) -----------------------------
//
// FirmwareController::statusAction() (github.com/opnsense/core,
// src/opnsense/mvc/app/controllers/OPNsense/Core/Api/FirmwareController.php)
// answers GET and POST alike; a synchronous "firmware probe" backend run only
// fires when the request IS a POST (`if ($this->request->isPost())`), so a
// plain GET is the cheap, read-only, no-side-effect probe: it proves the
// host, TLS trust setting and API key/secret all work without touching the
// firewall's pending configuration or triggering an update check.

export const FIRMWARE_STATUS_MODULE = ['core', 'firmware', 'status'] as const

export interface FirmwareStatus {
  product?: { product_version?: string; product_name?: string; product_arch?: string }
  status?: string
  status_msg?: string
}

export function getFirmwareStatus(client: OpnsenseClient): Promise<OpnsenseResult<FirmwareStatus>> {
  return client.request<FirmwareStatus>('GET', [...FIRMWARE_STATUS_MODULE])
}
