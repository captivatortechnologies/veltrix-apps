// =============================================================================
// Fake Netskope REST API v2 — the shared vendor stub every Netskope handler test
// drives.
//
// `validate` was the only handler with tests in this app; the four that reach a
// customer's tenant (deploy, rollback, healthCheck, driftDetect) and the one
// that reads the platform's own records (getStatus) had none. Every handler
// here reaches the vendor through `lib/netskope.ts`, which uses global `fetch`,
// so replacing `globalThis.fetch` with canned responses exercises a handler end
// to end — its request sequence, its bodies, its error handling and the
// rollback state it records — with no module mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// Four things about this app the harness has to account for:
//
//   * AUTH IS ONE HEADER, NOT A TOKEN EXCHANGE. Every request carries
//     `Netskope-Api-Token: <token>`; there is no login round trip, so the FIRST
//     call a handler makes is already real work against the tenant. That also
//     means the token is on the wire every single time — {@link assertTokenSent}
//     checks it, and {@link leaksToken} checks it never comes back out in a
//     message, artifact, rollbackData or diff.
//
//   * THE TENANT HOST IS AN APP SETTING, NOT THE COMPONENT. `readNetskopeSettings`
//     builds the base URL from `settings.tenant`; a blank one makes the
//     credential unusable no matter how good the token is. {@link settingsWithoutTenant}
//     models that.
//
//   * TWO LIST ENVELOPES. Policy/profile endpoints return a BARE JSON array
//     ({@link list}); NPA infrastructure/steering endpoints wrap it as
//     `{status, data: {<listKey>: [...]}}` ({@link npaList}). Both page with
//     limit/offset and stop on a short page, so one page per fixture is enough.
//
//   * A 200 CAN CARRY AN ERROR. Some v2 endpoints answer `{status: 'error',
//     message}` at HTTP 200 ({@link errorEnvelope}). `res.ok` is true for those,
//     which is exactly the shape a handler can mistake for an empty tenant.
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  ComponentRef,
  CredentialRef,
  DeployContext,
  DeploymentSummary,
  DriftContext,
  HealthCheckContext,
  PipelineContext,
  PlatformDataApi,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

// --- Secrets that must never escape ------------------------------------------

/**
 * The tenant's REST API v2 token. Distinctive on purpose: a result message,
 * artifact, rollbackData or diff carrying this string has leaked the customer's
 * API token into platform storage and the deployment log.
 */
export const API_TOKEN = 'netskope-api-v2-token-MUST-NOT-LEAK'

/** The tenant host, supplied as the app's `tenant` setting. */
export const TENANT = 'acme.goskope.com'

/** The base every request is expected to be built on. */
export const BASE_URL = `https://${TENANT}/api/v2`

// --- The fake transport -------------------------------------------------------

/** One outbound request the handler made, as the fake saw it. */
export interface RecordedCall {
  url: string
  method: string
  /** The serialised request body, or '' for a body-less request. */
  body: string
  /** The `Netskope-Api-Token` header — v2's entire authentication scheme. */
  apiToken: string | null
  contentType: string | null
}

/** One canned Netskope response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** Value for the `Retry-After` header, in seconds — only read on a 429. */
  retryAfter?: string
}

export interface FakeNetskope {
  calls: RecordedCall[]
  restore: () => void
}

function respond(next: CannedResponse) {
  const status = next.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => {
        const key = String(name).toLowerCase()
        if (key === 'retry-after') return next.retryAfter ?? null
        return 'application/json'
      },
    },
    text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
  }
}

function install(pick: (url: string, method: string) => CannedResponse): FakeNetskope {
  const calls: RecordedCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : '',
      apiToken: init?.headers?.['Netskope-Api-Token'] ?? null,
      contentType: init?.headers?.['Content-Type'] ?? null,
    })
    return respond(pick(url, method))
  }) as unknown as typeof globalThis.fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 * Responses are consumed in order; a request past the end of the queue gets an
 * empty bare collection.
 *
 * Use this only where the call ORDER is the point of the test. Most Netskope
 * deploys read two or three different collections before writing (a private-app
 * deploy reads apps then publishers; a custom-category deploy reads categories,
 * URL lists and destination profiles), so a queue is brittle — prefer
 * {@link routeFetch}.
 */
export function recordFetch(responses: CannedResponse[]): FakeNetskope {
  const queue = [...responses]
  return install(() => queue.shift() ?? { status: 200, body: [] })
}

/** One URL-matched rule for {@link routeFetch}. */
export interface Route {
  /** Matched against the full request URL. */
  url: RegExp
  /** Optional method filter, for an endpoint whose GET and PUT differ. */
  method?: string
  /** A single response reused for every match, or a queue consumed in order. */
  respond: CannedResponse | CannedResponse[]
}

/**
 * URL-matched variant of {@link recordFetch}. Routes are tried in order, so put
 * the more specific pattern first — `/policy/urllist/deploy` before
 * `/policy/urllist`. Anything unmatched gets `fallback`.
 */
export function routeFetch(routes: Route[], fallback: CannedResponse = { status: 200, body: [] }): FakeNetskope {
  const queues = new Map<Route, CannedResponse[]>()
  for (const route of routes) {
    if (Array.isArray(route.respond)) queues.set(route, [...route.respond])
  }

  return install((url, method) => {
    for (const route of routes) {
      if (route.method && route.method !== method) continue
      if (!route.url.test(url)) continue
      const queue = queues.get(route)
      if (!queue) return route.respond as CannedResponse
      // A queued route that has run out keeps answering with its last response,
      // so an extra page poll never silently becomes an empty collection.
      return queue.length > 1 ? (queue.shift() as CannedResponse) : (queue[0] ?? fallback)
    }
    return fallback
  })
}

// --- Canned responses ---------------------------------------------------------

/** A plain 200 acknowledgement with an optional body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A create response carrying the created object (Netskope answers 200 or 201). */
export function created(body: unknown, status = 200): CannedResponse {
  return { status, body }
}

/**
 * One terminating page of a policy/profile collection — a BARE JSON array.
 * `getAll` pages with limit=100 and stops on a short page, so a realistic
 * fixture is a single page.
 */
export function list(items: unknown[]): CannedResponse {
  return { status: 200, body: items }
}

/**
 * One terminating page of an NPA infrastructure/steering collection:
 * `{status, data: {<listKey>: [...]}}`. `getAllNpa` unwraps `data.<listKey>`.
 */
export function npaList(listKey: string, items: unknown[]): CannedResponse {
  return { status: 200, body: { status: 'success', data: { [listKey]: items } } }
}

/** A single NPA object under the `{status, data}` envelope (create / GET one). */
export function npaData(obj: unknown): CannedResponse {
  return { status: 200, body: { status: 'success', data: obj } }
}

/** A profiles-family create/GET response — the bare object, no envelope. */
export function bare(obj: unknown): CannedResponse {
  return { status: 200, body: obj }
}

/** Netskope's `{message}` error body at the given status. */
export function netskopeError(status: number, message: string): CannedResponse {
  return { status, body: { message } }
}

/** The tenant rejecting the API token outright. */
export function forbidden(message = 'API token is not authorized for this endpoint'): CannedResponse {
  return netskopeError(403, message)
}

/** The tenant being unable to answer — the case a handler must not read as "empty". */
export function serverError(message = 'Internal server error'): CannedResponse {
  return netskopeError(500, message)
}

/** Not found — a known answer, unlike a 5xx. */
export function notFound(message = 'Resource not found'): CannedResponse {
  return netskopeError(404, message)
}

/** A rejected write, e.g. a duplicate name or a malformed body. */
export function badRequest(message = 'Validation failed for the supplied body'): CannedResponse {
  return netskopeError(400, message)
}

/**
 * An ERROR delivered inside an HTTP 200 — Netskope v2's `{status, message}`
 * envelope. `res.ok` is true here, so a handler that only checks the status code
 * sees a successful response carrying no items, which is indistinguishable from
 * an empty tenant unless it inspects the envelope.
 */
export function errorEnvelope(message = 'internal error while reading configuration'): CannedResponse {
  return { status: 200, body: { status: 'error', message } }
}

/** A successful DELETE that returns no body. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }

// --- Call predicates ----------------------------------------------------------

/** Calls that change tenant state. A read-only handler must make none. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

/** Calls whose URL matches, e.g. the writes against one collection. */
export function callsTo(calls: RecordedCall[], pattern: RegExp): RecordedCall[] {
  return calls.filter((call) => pattern.test(call.url))
}

/** Parse a recorded request body. Returns null for a body-less request. */
export function bodyOf(call: RecordedCall | undefined): Record<string, unknown> | null {
  if (!call || !call.body) return null
  try {
    return JSON.parse(call.body) as Record<string, unknown>
  } catch {
    return null
  }
}

/** True when the API token appears anywhere in `value`. */
export function leaksToken(value: unknown): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(API_TOKEN)
}

/** True when `secret` appears anywhere in `value` — for per-type write-only fields. */
export function leaks(value: unknown, secret: string): boolean {
  return (JSON.stringify(value ?? null) ?? '').includes(secret)
}

export interface AssertLike {
  ok: (v: unknown, m?: string) => void
  equal: (a: unknown, b: unknown, m?: string) => void
}

/**
 * Assert every recorded call presented the API token and was addressed at the
 * tenant base built from the `tenant` setting. Returns the calls so a test can
 * go on asserting the request sequence.
 */
export function assertTokenSent(assert: AssertLike, calls: RecordedCall[]): RecordedCall[] {
  assert.ok(calls.length > 0, 'handler made no call at all')
  for (const call of calls) {
    assert.equal(call.apiToken, API_TOKEN, `call without the Netskope-Api-Token header: ${call.method} ${call.url}`)
    assert.ok(call.url.startsWith(BASE_URL), `call not addressed at the tenant base: ${call.url}`)
  }
  return calls
}

// --- Canvas + context ---------------------------------------------------------

/** Shorthand for one canvas item. `fields` is flat across presentational groups. */
export function item(name: string, fields: Record<string, unknown> = {}, id?: string): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'netskope', version = 3): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version,
    name: 'Test Canvas',
    toolType: 'netskope',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

/** A working credential: the v2 token in `password`, per the app's convention. */
export const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'Netskope REST API v2 token',
  username: '',
  password: API_TOKEN,
  apiToken: null,
  certificate: null,
}

/**
 * The same token supplied in `apiToken`, the field `lib/netskope.ts` documents
 * as an accepted alternative to `password`.
 *
 * Nothing asserts against this yet, on purpose: the resolver reads
 * `password ?? apiToken ?? ''`, and the platform supplies `password` as `''`
 * rather than null, so `??` short-circuits and the apiToken field is never read.
 * A credential shaped like this resolves to "no usable credential". The fixture
 * is kept so the fix has a test subject waiting for it — see the report
 * accompanying these tests.
 */
export const API_TOKEN_CREDENTIAL: CredentialRef = {
  id: 'cred-2',
  name: 'Netskope REST API v2 token (apiToken field)',
  username: '',
  password: '',
  apiToken: API_TOKEN,
  certificate: null,
}

/** A credential row that exists but carries no secret — present, but unusable. */
export const EMPTY_CREDENTIAL: CredentialRef = {
  id: 'cred-blank',
  name: 'Netskope token (blank)',
  username: '',
  password: '   ',
  apiToken: '',
  certificate: null,
}

export function component(over: Partial<ComponentRef> = {}): ComponentRef {
  return {
    id: 'comp-1',
    hostname: TENANT,
    port: '443',
    type: ['netskope'],
    toolId: 'netskope',
    ...over,
  }
}

/** The app's settings with a usable tenant host. */
export function defaultSettings(): Record<string, unknown> {
  return { tenant: TENANT, request_timeout_seconds: 30 }
}

/** Settings with NO tenant host — the base URL cannot be built, so nothing is addressable. */
export function settingsWithoutTenant(): Record<string, unknown> {
  return { request_timeout_seconds: 30 }
}

/** Per-test overrides — everything else is a working connection to the tenant. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the defaults; `{}` models a tenant host that was never set. */
  settings?: Record<string, unknown>
  /** Replaces the component; `null` models no registered tenant. */
  component?: ComponentRef | null
  /** What `platform.getLatestDeployment` should return — deploy reads its own prior entries from here. */
  latestDeployment?: DeploymentSummary | null
  /** Make `platform.getLatestDeployment` reject, to prove deploy survives it. */
  deploymentLookupFails?: boolean
  /** Canvas version, surfaced by getStatus. */
  version?: number
}

/** A SUCCEEDED deployment record, overridable field by field. */
export function deploymentSummary(over: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id: 'dep-1',
    canvasId: 'canvas-1',
    status: 'SUCCEEDED',
    healthScore: 100,
    startedAt: '2026-01-01T09:00:00.000Z',
    completedAt: '2026-01-01T09:05:00.000Z',
    environment: { id: 'env-1', name: 'production' },
    ...over,
  }
}

/** A prior deployment whose rollbackData carries the entries a deploy recorded. */
export function priorDeployment(entries: unknown[]): DeploymentSummary {
  return deploymentSummary({ rollbackData: { entries } })
}

function platformApi(over: ContextOverrides): PlatformDataApi {
  return {
    getLatestDeployment: async () => {
      if (over.deploymentLookupFails) throw new Error('platform deployment lookup unavailable')
      return over.latestDeployment ?? null
    },
    listComponents: async () => (over.component === null ? [] : [over.component ?? component()]),
  }
}

function baseContext(over: ContextOverrides) {
  const comp = over.component === undefined ? component() : over.component
  return {
    appId: 'netskope',
    customerId: 'cust-1',
    configTypeId: 'netskope',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: over.settings ?? defaultSettings(),
    platform: platformApi(over),
    component: comp,
    credential: over.credential === undefined ? CREDENTIAL : over.credential,
    connectivity: null,
    connectivityProvider: null,
  }
}

export function deployContext(items: CanvasItemSnapshot[], over: ContextOverrides = {}): DeployContext {
  return {
    ...baseContext(over),
    canvas: canvas(items, 'netskope', over.version ?? 3),
    previousConfig: null,
    strategy: 'DIRECT',
  } as unknown as DeployContext
}

export function rollbackContext(rollbackData: unknown, over: ContextOverrides = {}): RollbackContext {
  return {
    ...baseContext(over),
    canvas: canvas([]),
    rollbackData,
    targetVersion: canvas([]),
  } as unknown as RollbackContext
}

export function healthContext(items: CanvasItemSnapshot[] = [], over: ContextOverrides = {}): HealthCheckContext {
  return {
    ...baseContext(over),
    canvas: canvas(items),
  } as unknown as HealthCheckContext
}

/**
 * A drift context. `deployedItems` is what the last deploy recorded — the
 * DESIRED state drift compares against — and is what every Netskope driftDetect
 * reads (`ctx.deployedConfig`), never `ctx.canvas`.
 */
export function driftContext(deployedItems: CanvasItemSnapshot[], over: ContextOverrides = {}): DriftContext {
  return {
    ...baseContext(over),
    canvas: canvas(deployedItems),
    deployedConfig: canvas(deployedItems),
  } as unknown as DriftContext
}

// --- getStatus ----------------------------------------------------------------
// getStatus is the one handler that never touches the tenant: it reads the
// platform's own deployment record through `ctx.platform` and reports the
// component already on the context. It is identical across all 22 configuration
// types, so the contract that drives it lives in `netskopeContracts.ts`.

export interface StatusProbe {
  ctx: PipelineContext
  /** Each `getLatestDeployment` call, in order. */
  deploymentQueries: Array<{ canvasId: string; status?: string }>
}

/**
 * Build a PipelineContext whose platform API returns `latest`, recording every
 * query the handler makes against it.
 */
export function statusContext(
  configTypeId: string,
  opts: {
    latest?: DeploymentSummary | null
    component?: ComponentRef | null
    version?: number
    /** Make the platform lookup reject — status is best-effort and must survive it. */
    lookupFails?: boolean
  } = {},
): StatusProbe {
  const deploymentQueries: StatusProbe['deploymentQueries'] = []
  const comp = opts.component === undefined ? component() : opts.component

  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, args) => {
      deploymentQueries.push({ canvasId, status: args?.status })
      if (opts.lookupFails) throw new Error('platform deployment lookup unavailable')
      return opts.latest ?? null
    },
    listComponents: async () => (comp ? [comp] : []),
  }

  const ctx = {
    appId: 'netskope',
    customerId: 'cust-1',
    configTypeId,
    canvas: canvas([], configTypeId, opts.version ?? 3),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: defaultSettings(),
    platform,
    component: comp,
    credential: CREDENTIAL,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries }
}
