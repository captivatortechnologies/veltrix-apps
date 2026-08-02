// =============================================================================
// OPNsense REST API client — HTTP Basic (API key + secret) transport with
// self-signed-TLS handling, plus the firewall alias / category / filter-rule /
// source-NAT resource helpers.
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

// --- Generic mutable-model resource (addXxx/setXxx/delXxx/searchXxx) ----------
//
// Every OPNsense "mutable model" controller shares the exact same CRUD
// envelope — verified against ApiMutableModelControllerBase.php's
// addBase/setBase/delBase/searchBase (github.com/opnsense/core,
// src/opnsense/mvc/app/controllers/OPNsense/Base/ApiMutableModelControllerBase.php)
// — only the URL's action-verb naming differs per controller:
//   - Alias / Category use the base class's own default names: addItem /
//     setItem / delItem / searchItem.
//   - Filter / SourceNat (FilterController / SourceNatController, both
//     extending FilterBaseController) define their OWN action names on top of
//     the SAME addBase/setBase/delBase methods: addRule / setRule / delRule /
//     searchRule.
// This factory captures the shared shape ONCE; each resource below only
// supplies its module path, its body's wrapper key, and — when it isn't
// "Item" — its verb set. Response shapes, verified:
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

interface ModelVerbs {
  search: string
  add: string
  set: string
  del: string
}

const ITEM_VERBS: ModelVerbs = { search: 'searchItem', add: 'addItem', set: 'setItem', del: 'delItem' }
const RULE_VERBS: ModelVerbs = { search: 'searchRule', add: 'addRule', set: 'setRule', del: 'delRule' }

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

function buildModelResource<TLive extends ModelRecord, TBody extends object>(
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

// --- Firewall Alias resource (api/firewall/alias/*) ---------------------------
//
// Verified against OPNsense core's own source (github.com/opnsense/core):
//   controller: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/AliasController.php
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
 * that mistake structurally impossible. The same rule applies to EVERY other
 * resource below (categories, filter rules, source NAT rules).
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
export interface LiveAlias extends ModelRecord {
  enabled?: string
  name?: string
  type?: string
  content?: string
  description?: string
  proto?: string
  interface?: string
  updatefreq?: string
}

function aliasResource(client: OpnsenseClient): ModelResource<LiveAlias, AliasBody> {
  return buildModelResource<LiveAlias, AliasBody>(client, ALIAS_MODULE, 'alias')
}

/**
 * List every configured alias. `GET|POST /api/firewall/alias/searchItem`.
 * The server defaults `rowCount` to `-1` ("all results", one page —
 * UIModelGrid::fetchBindRequest/fetch) whenever it is omitted, so a bare call
 * with no query params already returns the complete set: no pagination loop
 * needed, unlike a tool whose list endpoint hard-caps a page size.
 */
export function searchAliases(client: OpnsenseClient): Promise<LiveAlias[]> {
  return aliasResource(client).search()
}

/** `POST /api/firewall/alias/addItem` — body `{ alias: {...} }`. Returns the new uuid. */
export function addAlias(client: OpnsenseClient, body: AliasBody): Promise<string> {
  return aliasResource(client).add(body)
}

/** `POST /api/firewall/alias/setItem/<uuid>` — body `{ alias: {...} }`. */
export function setAlias(client: OpnsenseClient, uuid: string, body: AliasBody): Promise<void> {
  return aliasResource(client).set(uuid, body)
}

/**
 * `POST /api/firewall/alias/delItem/<uuid>`. AliasController::delItemAction
 * checks `whereUsed()` first and throws ("Alias in use") if another alias or
 * a firewall/NAT rule still references this one by name — that failure
 * surfaces here as a thrown Error whose message names the blocker.
 */
export function deleteAlias(client: OpnsenseClient, uuid: string): Promise<void> {
  return aliasResource(client).remove(uuid)
}

/**
 * `POST /api/firewall/alias/reconfigure` — the APPLY step described in the
 * module doc above. Every deploy/rollback that staged at least one
 * add/set/delItem call MUST call this once, after every stage call, before
 * reporting success — otherwise the staged changes sit in the pending
 * configuration and never reach the running pf ruleset. Verified success
 * shape: AliasController::reconfigureAction always returns the literal
 * `{"status":"ok"}` on success (never a passthrough value), unlike the
 * Filter/SourceNat apply step below.
 */
export async function reconfigureAliases(client: OpnsenseClient): Promise<void> {
  const res = await client.request<{ status?: string }>('POST', [...ALIAS_MODULE, 'reconfigure'])
  if (res.data?.status === 'ok') return
  throw new Error(`reconfigure failed — staged alias changes were NOT applied: ${opnsenseErrorMessage(res)}`)
}

// --- Firewall Category resource (api/firewall/category/*) --------------------
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/CategoryController.php
// + src/opnsense/mvc/app/models/OPNsense/Firewall/Category.xml. Categories are
// pure metadata TAGS referenced by name from aliases, filter rules and source
// NAT rules for grouping/color-coding — they have NO live effect on pf, so
// there is no apply/reconfigure step for this resource at all (confirmed: no
// such action exists on CategoryController). This is the oldest of the four
// resources here — the model landed in core back in January 2021 (issue
// #4587), long before any OPNsense version this app would plausibly target,
// so — unlike firewall-rules/source-nat below — there is no meaningful
// version-floor to flag.

export const CATEGORY_MODULE = ['firewall', 'category'] as const

export interface CategoryBody {
  name: string
  color: string // 6 hex digits (e.g. "FF8800"), or "" for none
}

/**
 * `auto` marks a small set of SYSTEM-managed categories (e.g. an "Anti-Lockout"
 * category some Destination NAT versions auto-create) — verified present as a
 * plain BooleanField on the model. This app never creates, edits or deletes a
 * category whose live `auto` is "1", the same way this codebase's Cisco ISE
 * app leaves ISE's system-defined identity groups alone.
 */
export interface LiveCategory extends ModelRecord {
  name?: string
  color?: string
  auto?: string
}

function categoryResource(client: OpnsenseClient): ModelResource<LiveCategory, CategoryBody> {
  return buildModelResource<LiveCategory, CategoryBody>(client, CATEGORY_MODULE, 'category')
}

/** `GET|POST /api/firewall/category/searchItem` — same `rowCount: -1` ("all results") default as aliases. */
export function searchCategories(client: OpnsenseClient): Promise<LiveCategory[]> {
  return categoryResource(client).search()
}

/** `POST /api/firewall/category/addItem` — body `{ category: {...} }`. Returns the new uuid. */
export function addCategory(client: OpnsenseClient, body: CategoryBody): Promise<string> {
  return categoryResource(client).add(body)
}

/** `POST /api/firewall/category/setItem/<uuid>` — body `{ category: {...} }`. */
export function setCategory(client: OpnsenseClient, uuid: string, body: CategoryBody): Promise<void> {
  return categoryResource(client).set(uuid, body)
}

/**
 * `POST /api/firewall/category/delItem/<uuid>`. CategoryController::delItemAction
 * checks `Category::isUsed()` first and throws ("Category in use") if any
 * alias/rule/NAT entry still references it — surfaced as a thrown Error.
 */
export function deleteCategory(client: OpnsenseClient, uuid: string): Promise<void> {
  return categoryResource(client).remove(uuid)
}

// --- Firewall Filter Rule resource (api/firewall/filter/*) --------------------
//
// *** REQUIRES OPNsense 24.1 "Savvy Shark" (released January 30, 2024) OR
// LATER. *** Verified two independent ways:
//   1. The official changelog (github.com/opnsense/changelog,
//      community/24.1/24.1): "firewall: add automation category for filter
//      rules and source NAT using MVC/API, formerly known as os-firewall
//      plugin" and "plugins: os-firewall moved to core".
//   2. The core commit that introduced these controllers (github.com/
//      opnsense/core, commit 8e299d3e, 2024-01-07, "import net/os-firewall
//      from plugins", https://github.com/opnsense/core/issues/6390) — which
//      added FilterController.php, FilterBaseController.php AND
//      SourceNatController.php in the SAME commit.
// Before 24.1 this functionality existed ONLY as a separately-installed
// "os-firewall" plugin (not guaranteed present, not core) — on an un-upgraded
// pre-24.1 box, every endpoint below returns 404, not a validation error.
//
// Verified: src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/
// FilterController.php + FilterBaseController.php, and the shared model
// src/opnsense/mvc/app/models/OPNsense/Firewall/Filter.xml (mount
// //OPNsense/Firewall/Filter — the SAME model file backs filter rules
// (`rules.rule`), source NAT (`snatrules.rule`), NPTv6 (`npt.rule`) and
// 1:1 NAT (`onetoone.rule`); this app only manages the first two).

export const FILTER_MODULE = ['firewall', 'filter'] as const

/**
 * Ordering — verified against FilterRuleContainerField::getPriority() /
 * FilterRuleField::actionPostLoadingEvent() (src/opnsense/mvc/app/models/
 * OPNsense/Firewall/FieldTypes/FilterRuleField.php), which run on EVERY
 * model load: `prio_group` is a VOLATILE, SERVER-COMPUTED bucket derived
 * purely from `interface` + `interfacenot` (floating: 0 or 2+ interfaces, or
 * interfacenot set; a single OPNsense interface-GROUP; a single ordinary
 * interface; or "invalid" when the named interface doesn't exist) — this app
 * never sends `prio_group` or `sort_order`, only `sequence`. Rules are then
 * sorted `sort_order = "{prio_group}.0{sequence:06d}"`, so `sequence` only
 * orders rules WITHIN the SAME bucket — a floating rule with sequence 1
 * always evaluates before EVERY single-interface rule regardless of that
 * rule's own sequence, because floating's bucket (200000) sorts before a
 * plain interface rule's bucket (400000). This app does not attempt to
 * replicate the UI's drag-and-drop gap-renumbering (moveRuleBefore) — declare
 * well-spaced `sequence` values (e.g. 10, 20, 30) for easy future insertion.
 */
export interface FilterRuleBody {
  enabled: string
  statetype: string
  sequence: string
  action: string
  quick: string
  interfacenot: string
  interface: string // comma-joined (Multiple=Y) — "" = floating (no interface restriction)
  direction: string
  ipprotocol: string
  protocol: string
  source_net: string // comma-joined (Multiple=Y)
  source_not: string
  source_port: string
  destination_net: string // comma-joined (Multiple=Y)
  destination_not: string
  destination_port: string
  log: string
  categories: string // comma-joined category UUIDs
  description: string
}

export interface LiveFilterRule extends ModelRecord {
  enabled?: string
  action?: string
  interface?: string
  interfacenot?: string
  direction?: string
  ipprotocol?: string
  protocol?: string
  source_net?: string
  source_not?: string
  source_port?: string
  destination_net?: string
  destination_not?: string
  destination_port?: string
  log?: string
  categories?: string
  statetype?: string
  sequence?: string
  sort_order?: string
  prio_group?: string
  description?: string
}

function filterRuleResource(client: OpnsenseClient): ModelResource<LiveFilterRule, FilterRuleBody> {
  return buildModelResource<LiveFilterRule, FilterRuleBody>(client, FILTER_MODULE, 'rule', RULE_VERBS)
}

/**
 * `GET|POST /api/firewall/filter/searchRule`. UNLIKE alias/category's
 * `searchItem` (UIModelGrid, `rowCount: -1` = literally unlimited),
 * `searchRule` runs over `ApiControllerBase::searchRecordsetBase()`, whose own
 * default is `rowCount: 9999` (NOT -1) when the param is omitted — verified
 * in ApiControllerBase.php. A bare call therefore returns up to 9999 rules in
 * one page: functionally "everything" for any realistic ruleset, but not
 * literally unbounded the way alias/category search is. Flagged, not faked.
 */
export function searchFilterRules(client: OpnsenseClient): Promise<LiveFilterRule[]> {
  return filterRuleResource(client).search()
}

/** `POST /api/firewall/filter/addRule` — body `{ rule: {...} }`. Returns the new uuid. */
export function addFilterRule(client: OpnsenseClient, body: FilterRuleBody): Promise<string> {
  return filterRuleResource(client).add(body)
}

/** `POST /api/firewall/filter/setRule/<uuid>` — body `{ rule: {...} }`. */
export function setFilterRule(client: OpnsenseClient, uuid: string, body: FilterRuleBody): Promise<void> {
  return filterRuleResource(client).set(uuid, body)
}

/** `POST /api/firewall/filter/delRule/<uuid>`. */
export function deleteFilterRule(client: OpnsenseClient, uuid: string): Promise<void> {
  return filterRuleResource(client).remove(uuid)
}

/**
 * `POST /api/firewall/<module>/apply` — the APPLY step for BOTH filter rules
 * and source NAT rules. FilterBaseController::applyAction() runs
 * `filter reload skip_alias` — a full pf ruleset reload — and returns
 * `{"status": <raw configdRun output>}`. SourceNatController extends
 * FilterBaseController and does NOT override applyAction, so
 * `/api/firewall/source_nat/apply` runs the EXACT SAME backend command;
 * applying either module's changes effectively applies both (rules and NAT
 * share one pf.conf reload) — this app still calls its own module's `apply`
 * from each config type's deploy/rollback so each stays correct in isolation.
 * FLAGGED: only `"error"` (returned when the request isn't a POST, which this
 * client never sends) is a PINNED failure literal in the source read for this
 * app — the SUCCESS value is whatever `configdRun('filter reload skip_alias')`
 * prints, not a fixed "ok" the way alias's reconfigure is. This helper treats
 * any non-"error", non-empty status as success and surfaces the raw value.
 */
export async function applyFilterModule(client: OpnsenseClient, module: readonly string[]): Promise<string> {
  const res = await client.request<{ status?: string }>('POST', [...module, 'apply'])
  if (res.ok && res.data?.status && res.data.status !== 'error') return res.data.status
  throw new Error(`apply failed — staged changes were NOT applied: ${opnsenseErrorMessage(res)}`)
}

// --- Firewall Source NAT (outbound NAT) resource (api/firewall/source_nat/*) --
//
// *** Same OPNsense 24.1+ requirement as firewall-filter above *** —
// SourceNatController.php was added in the SAME commit (8e299d3e) as
// FilterController.php/FilterBaseController.php. Verified:
// src/opnsense/mvc/app/controllers/OPNsense/Firewall/Api/SourceNatController.php
// (`snatrules.rule` in the SAME shared Filter.xml model as filter rules).
//
// Outbound NAT MODE gate — verified in Filter.xml's `general.snat_mode`
// (OptionValues: automatic / hybrid / advanced / disabled, default
// "automatic") and SourceNatController::searchRuleAction()'s own mode switch:
// manual `snatrules.rule` entries are only ever evaluated by pf when the mode
// is "hybrid" or "advanced" ("manual"). In "automatic" (the OPNsense DEFAULT)
// or "disabled" mode, this app's rules stage into config.xml and `apply`
// happily reloads the ruleset, but the rules have ZERO effect — OPNsense
// generates its own automatic outbound rules instead. This app does not
// change `snat_mode` itself (a global setting outside this config type's
// scope) — see `getSourceNatMode` below, surfaced as a healthCheck warning.

export const SOURCE_NAT_MODULE = ['firewall', 'source_nat'] as const

export interface SourceNatRuleBody {
  enabled: string
  nonat: string
  sequence: string
  interface: string // single value (no Multiple flag on this model's interface field)
  ipprotocol: string
  protocol: string
  source_net: string // single value
  source_not: string
  source_port: string
  destination_net: string // single value
  destination_not: string
  destination_port: string
  target: string // blank = the interface's own address
  target_port: string
  staticnatport: string
  log: string
  categories: string // comma-joined category UUIDs
  'endpoint-independent': string
  description: string
}

export interface LiveSourceNatRule extends ModelRecord {
  enabled?: string
  nonat?: string
  interface?: string
  ipprotocol?: string
  protocol?: string
  source_net?: string
  source_not?: string
  source_port?: string
  destination_net?: string
  destination_not?: string
  destination_port?: string
  target?: string
  target_port?: string
  staticnatport?: string
  log?: string
  categories?: string
  sequence?: string
  description?: string
  /** True for OPNsense's own synthetic automatic-mode rows (never returned for manual rules this app owns). */
  is_automatic?: boolean
}

function sourceNatRuleResource(client: OpnsenseClient): ModelResource<LiveSourceNatRule, SourceNatRuleBody> {
  return buildModelResource<LiveSourceNatRule, SourceNatRuleBody>(client, SOURCE_NAT_MODULE, 'rule', RULE_VERBS)
}

/** `GET|POST /api/firewall/source_nat/searchRule` — same `rowCount: 9999` default caveat as filter rules. */
export function searchSourceNatRules(client: OpnsenseClient): Promise<LiveSourceNatRule[]> {
  return sourceNatRuleResource(client).search()
}

/** `POST /api/firewall/source_nat/addRule` — body `{ rule: {...} }`. Returns the new uuid. */
export function addSourceNatRule(client: OpnsenseClient, body: SourceNatRuleBody): Promise<string> {
  return sourceNatRuleResource(client).add(body)
}

/** `POST /api/firewall/source_nat/setRule/<uuid>` — body `{ rule: {...} }`. */
export function setSourceNatRule(client: OpnsenseClient, uuid: string, body: SourceNatRuleBody): Promise<void> {
  return sourceNatRuleResource(client).set(uuid, body)
}

/** `POST /api/firewall/source_nat/delRule/<uuid>`. */
export function deleteSourceNatRule(client: OpnsenseClient, uuid: string): Promise<void> {
  return sourceNatRuleResource(client).remove(uuid)
}

/**
 * The current outbound-NAT mode (`general.snat_mode` on the shared Filter
 * model — see the module doc above). BEST-EFFORT: `GET
 * /api/firewall/source_nat/get` (SourceNatController::getAction, inherited
 * from ApiMutableModelControllerBase::getAction/getModelNodes) returns OPTION
 * fields in their full FORM representation — `{ optionKey: { selected: "1"|1,
 * ... }, ... }` — the same shape this app already relies on for Alias
 * `content` in firewall-aliases. That shape is well-established for OPTION
 * fields generally, but has not been exercised against a live box for THIS
 * specific field, so a parse miss degrades to `null` (callers skip the mode
 * warning) instead of throwing.
 */
export async function getSourceNatMode(client: OpnsenseClient): Promise<string | null> {
  const res = await client.request<{ filter?: { general?: { snat_mode?: unknown } } }>('GET', [...SOURCE_NAT_MODULE, 'get'])
  const raw = res.data?.filter?.general?.snat_mode
  if (typeof raw === 'string') return raw || null
  if (raw && typeof raw === 'object') {
    for (const [key, opt] of Object.entries(raw as Record<string, unknown>)) {
      const selected = (opt as { selected?: unknown } | null)?.selected
      if (selected === 1 || selected === '1' || selected === true) return key
    }
  }
  return null
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
