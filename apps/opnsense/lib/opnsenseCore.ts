// =============================================================================
// OPNsense REST API core — HTTP Basic (API key + secret) transport with
// self-signed-TLS handling, the generic mutable-model resource factory every
// per-module resource file in this app builds on, and the two "apply" idioms
// those modules share. Split out of the original single lib/opnsenseApi.ts
// (which now re-exports everything here, plus every resource file, as a
// barrel) once the number of managed API surfaces made one file unwieldy —
// see CLAUDE.md's file-size guidance.
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
// URL segment derivation — verified against OPNsense's own MVC router
// (github.com/opnsense/core, src/opnsense/mvc/app/library/OPNsense/Mvc/
// Router.php::parsePath()): each `/`-separated URL segment is transformed via
// `lcfirst(str_replace('_', '', ucwords($segment, '_')))` (plus "Controller"/
// "Action" suffixes) to resolve the PHP class/method. For a camelCase segment
// with NO underscore (e.g. "addItem", "searchRule") this round-trips to
// EXACTLY the same string — ucwords capitalizes the leading letter, lcfirst
// immediately undoes it, and there are no underscores to strip. For a
// multi-word module/controller segment, an underscore IS required to reach
// the PascalCase class name ("source_nat" -> "SourceNat" -> matches
// SourceNatController; "one_to_one" -> "OneToOne" -> matches
// OneToOneController). This is why every resource file below spells its
// module path with underscores where the PHP class name has multiple words,
// and copies a controller's action names byte-for-byte (case included) —
// e.g. Routes' actions are genuinely all-lowercase ("searchroute", not
// "searchRoute") because that IS the literal PHP method name
// (searchrouteAction), and the router's transform is a no-op on an
// already-lowercase, underscore-free segment.
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

// --- Generic mutable-model resource (addXxx/setXxx/delXxx/searchXxx) ----------
//
// Every OPNsense "mutable model" controller shares the exact same CRUD
// envelope — verified against ApiMutableModelControllerBase.php's
// addBase/setBase/delBase/searchBase (github.com/opnsense/core,
// src/opnsense/mvc/app/controllers/OPNsense/Base/ApiMutableModelControllerBase.php)
// — only the URL's action-verb naming differs per controller (see the
// Router.php note above for exactly why each verb set below is spelled the
// way it is):
//   - Alias / Category use the base class's own default names: addItem /
//     setItem / delItem / searchItem.
//   - Filter / SourceNat / OneToOne (all extending FilterBaseController)
//     define addRule / setRule / delRule / searchRule.
//   - TrafficShaper's three resources (pipe/queue/rule) use a SINGULAR verb
//     for add/set/del but a PLURAL one for search (searchPipes, not
//     searchPipe) — each spelled out at its own call site.
//   - Unbound's host/forward overrides use addHostOverride/addForward etc.
//   - Routes uses all-lowercase, no-camelCase verbs (searchroute, addroute).
// This factory captures the shared shape ONCE; each resource file only
// supplies its module path, its body's wrapper key, and its verb set.
// Response shapes, verified:
//   add:    { result: "saved", uuid } | { result: "failed", validations }
//   set:    { result: "saved" }       | { result: "failed", validations }
//   delete: { result: "deleted" } | { result: "not found" } | (thrown, e.g. "in use")
//   search: { rows: [...], rowCount, total, current }

export interface ModelRecord {
  uuid: string
  [key: string]: unknown
}

interface MutateResponse {
  result?: string
  uuid?: string
  validations?: Record<string, unknown>
}

export interface ModelVerbs {
  search: string
  add: string
  set: string
  del: string
}

export const ITEM_VERBS: ModelVerbs = { search: 'searchItem', add: 'addItem', set: 'setItem', del: 'delItem' }
export const RULE_VERBS: ModelVerbs = { search: 'searchRule', add: 'addRule', set: 'setRule', del: 'delRule' }

export interface ModelResource<TLive extends ModelRecord, TBody extends object> {
  /** List every configured record — flat field values. See each resource's own doc for its exact page-size default. */
  search(): Promise<TLive[]>
  /** Create a record; returns the new uuid. */
  add(body: TBody): Promise<string>
  /** Update a record by uuid. setBase() only overwrites the SUPPLIED keys (a merge) — always send every managed field. */
  set(uuid: string, body: TBody): Promise<void>
  /** Delete a record by uuid. Some resources reject this (e.g. "still in use") — surfaced as a thrown Error. */
  remove(uuid: string): Promise<void>
}

export function buildModelResource<TLive extends ModelRecord, TBody extends object>(
  client: OpnsenseClient,
  module: readonly string[],
  wrapperKey: string,
  verbs: ModelVerbs = ITEM_VERBS,
): ModelResource<TLive, TBody> {
  return {
    async search() {
      const res = await client.request<{ rows?: TLive[] }>('GET', [...module, verbs.search])
      if (!res.ok) throw new Error(`${verbs.search} failed: ${opnsenseErrorMessage(res)}`)
      return res.data?.rows ?? []
    },
    async add(body) {
      const res = await client.request<MutateResponse>('POST', [...module, verbs.add], { [wrapperKey]: body })
      if (res.data?.result === 'saved' && res.data.uuid) return res.data.uuid
      throw new Error(`${verbs.add} failed: ${opnsenseErrorMessage(res)}`)
    },
    async set(uuid, body) {
      const res = await client.request<MutateResponse>('POST', [...module, verbs.set, uuid], { [wrapperKey]: body })
      if (res.data?.result === 'saved') return
      throw new Error(`${verbs.set} "${uuid}" failed: ${opnsenseErrorMessage(res)}`)
    },
    async remove(uuid) {
      const res = await client.request<MutateResponse>('POST', [...module, verbs.del, uuid])
      if (res.data?.result === 'deleted' || res.data?.result === 'not found') return
      throw new Error(`${verbs.del} "${uuid}" failed: ${opnsenseErrorMessage(res)}`)
    },
  }
}

// --- The two "apply" idioms shared across every resource file -----------------
//
// 1. reconfigureModule — a literal `{"status":"ok"}` success contract.
//    Verified for FOUR independent controllers: AliasController::
//    reconfigureAction (always the literal "ok"), and
//    ApiMutableServiceControllerBase::reconfigureAction (the generic service
//    base class Unbound's ServiceController inherits unmodified), plus
//    TrafficShaper's and Routes' own ServiceController/RoutesController
//    overrides — all four return exactly `{"status":"ok"}` on success and
//    something OTHER than "ok" (never a passthrough value) on failure.
export async function reconfigureModule(client: OpnsenseClient, module: readonly string[], action = 'reconfigure'): Promise<void> {
  const res = await client.request<{ status?: string }>('POST', [...module, action])
  if (res.data?.status === 'ok') return
  throw new Error(`${action} failed — staged changes were NOT applied: ${opnsenseErrorMessage(res)}`)
}

// 2. applyFilterModule — the LENIENT contract used by FilterBaseController's
//    own `applyAction()` (Firewall Rules / Source NAT / 1:1 NAT all extend
//    it and do not override it): it runs `filter reload skip_alias` and
//    returns `{"status": <raw configdRun output>}` — NOT a pinned "ok"
//    literal. Only `"error"` (returned when the request isn't a POST, which
//    this client never sends) is a pinned failure value in the source read
//    for this app. Treats any other non-empty status as success and surfaces
//    the raw value for visibility, rather than assuming a fixed literal.
export async function applyFilterModule(client: OpnsenseClient, module: readonly string[]): Promise<string> {
  const res = await client.request<{ status?: string }>('POST', [...module, 'apply'])
  if (res.ok && res.data?.status && res.data.status !== 'error') return res.data.status
  throw new Error(`apply failed — staged changes were NOT applied: ${opnsenseErrorMessage(res)}`)
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
