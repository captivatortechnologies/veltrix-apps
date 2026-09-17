// =============================================================================
// Fake Zscaler OneAPI — the shared vendor stub every Zscaler handler test drives.
//
// `validate` was the only handler with tests in this app; the five that reach a
// customer's ZIA/ZPA tenant (deploy, rollback, healthCheck, driftDetect) or the
// platform's own records (getStatus) had none. Every handler here reaches the
// vendor through `lib/zscaler.ts`, which uses global `fetch`, so replacing
// `globalThis.fetch` with canned responses exercises a handler end to end — its
// OAuth2 token exchange, its request sequence, its bodies, its error handling
// and the rollback state it records — with no module mocking and no new
// dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// Three things about this app the harness has to account for:
//
//   * THE TOKEN CACHE IS MODULE-SCOPE. `lib/zscaler.ts` caches the bearer token
//     in a `Map` keyed `<vanity>|<clientId>|<apiHost>`, which outlives a single
//     test inside one bundled file. A second test reusing the same vanity would
//     silently skip the token exchange and every queue-based fixture after it
//     would be off by one. So `component()` mints a FRESH vanity per context —
//     every handler invocation authenticates, exactly as a cold platform worker
//     would.
//
//   * A 401 IS RETRIED. `ZscalerClient.request` treats a 401 as an expired
//     cached token: it drops the cache and replays the request, which costs a
//     second token exchange AND a second vendor call. A queue fixture for a 401
//     therefore needs four entries, not two — prefer {@link routeFetch} there.
//
//   * ZIA AND ZPA PAGE DIFFERENTLY. ZIA list endpoints return a bare JSON array
//     and stop on a short page; ZPA returns `{ list, totalPages }` and stops
//     when the page counter passes `totalPages`. {@link ziaList} and
//     {@link zpaList} produce a single terminating page of each.
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  ComponentRef,
  CredentialRef,
  CredentialRef as Cred,
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
 * The bearer token the fake Zidentity token endpoint hands out. Distinctive on
 * purpose: a result message, artifact, rollbackData or diff carrying this string
 * has leaked the tenant's OneAPI access token.
 */
export const ACCESS_TOKEN = 'zscaler-oneapi-access-token-MUST-NOT-LEAK'

/** The OneAPI API client's secret — equally must never surface. */
export const CLIENT_SECRET = 'zscaler-oneapi-client-secret-MUST-NOT-LEAK'

/** The OneAPI API client id. Also the identity our own deploys are recorded under. */
export const CLIENT_ID = 'veltrix-oneapi-client-9988'

/** The ZPA tenant id, supplied as an app setting (it is not in the token). */
export const ZPA_CUSTOMER_ID = '216196257331370351'

// --- The fake transport -------------------------------------------------------

/** One outbound request the handler made, as the fake saw it. */
export interface RecordedCall {
  url: string
  method: string
  /** The serialised request body, or '' for a body-less request. */
  body: string
  /** The `Authorization` header — OneAPI wants `Bearer <token>`. */
  authorization: string | null
  contentType: string | null
}

/** One canned OneAPI response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** Value for the `Retry-After` header, in seconds — only read on a 429. */
  retryAfter?: string
}

export interface FakeZscaler {
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
        if (key === 'x-ratelimit-reset') return null
        return 'application/json'
      },
    },
    text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
  }
}

function install(
  pick: (url: string, method: string) => CannedResponse,
): FakeZscaler {
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
      authorization: init?.headers?.Authorization ?? null,
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
 * empty ZIA collection, so an optional trailing listing never needs fixturing.
 *
 * The FIRST response a handler consumes is always the token exchange, because
 * `component()` hands every context a vanity the token cache has never seen.
 */
export function recordFetch(responses: CannedResponse[]): FakeZscaler {
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
 * URL-matched variant of {@link recordFetch}. Prefer it whenever the handler's
 * call count is not the point of the test — above all for a 401, which
 * `ZscalerClient` silently retries (dropping its cached token first), so the
 * real sequence is token, call, token, call and a two-entry queue would feed the
 * retry an unrelated response.
 *
 * Routes are tried in order, so put the more specific pattern first. The token
 * endpoint is served automatically unless a route claims it — which is how a
 * test injects a token failure. Anything unmatched gets `fallback`.
 */
export function routeFetch(
  routes: Route[],
  fallback: CannedResponse = { status: 200, body: [] },
): FakeZscaler {
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
    if (TOKEN_RE.test(url)) return TOKEN
    return fallback
  })
}

// --- Canned responses ---------------------------------------------------------

/** The successful Zidentity client-credentials response. */
export const TOKEN: CannedResponse = {
  status: 200,
  body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' },
}

/** A rejected token exchange — Zidentity answers `error`/`error_description`. */
export function tokenError(
  description = 'invalid_client: the client secret is expired or incorrect',
): CannedResponse {
  return { status: 401, body: { error: 'invalid_client', error_description: description } }
}

/**
 * One terminating page of a ZIA collection. ZIA list endpoints return a bare
 * JSON array and `ziaGetAll` stops as soon as a page is shorter than pageSize
 * (1000), so any realistic fixture is a single page.
 */
export function ziaList(items: unknown[]): CannedResponse {
  return { status: 200, body: items }
}

/**
 * One terminating page of a ZPA collection: `{ list, totalPages }`. `zpaGetAll`
 * stops once the page counter reaches `totalPages`.
 */
export function zpaList(items: unknown[], totalPages = 1): CannedResponse {
  return { status: 200, body: { list: items, totalPages: String(totalPages), totalCount: String(items.length) } }
}

/** A plain 200 acknowledgement with an optional body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A 200 create response carrying the created object (ZIA/ZPA both answer 200). */
export function created(body: unknown): CannedResponse {
  return { status: 200, body }
}

/** ZIA's 204 for a successful DELETE. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }

/** A ZIA error body — `{ code, message }` at the given status. */
export function ziaError(status: number, message: string, code = 'INVALID_INPUT_ARGUMENT'): CannedResponse {
  return { status, body: { code, message } }
}

/** A ZPA error body — `{ id, reason }` at the given status. */
export function zpaError(status: number, reason: string, id = 'invalid.request'): CannedResponse {
  return { status, body: { id, reason } }
}

/** The vendor rejecting the credential outright. */
export function forbidden(message = 'API key not authorized for this resource'): CannedResponse {
  return ziaError(403, message, 'AUTHENTICATION_FAILED')
}

/** The vendor being unable to answer — the case a handler must not read as "empty". */
export function serverError(message = 'Internal server error'): CannedResponse {
  return ziaError(500, message, 'UNEXPECTED_ERROR')
}

/** Not found — a known answer, unlike a 5xx. */
export function notFound(message = 'Resource not found'): CannedResponse {
  return ziaError(404, message, 'RESOURCE_NOT_FOUND')
}

/** ZIA's activation acknowledgement (`POST /status/activate`). */
export const ACTIVATED: CannedResponse = { status: 200, body: { status: 'ACTIVE' } }

/** ZIA's activation status read (`GET /status`). */
export function activationStatus(status = 'ACTIVE'): CannedResponse {
  return { status: 200, body: { status } }
}

// --- Call predicates ----------------------------------------------------------

const TOKEN_RE = /\/oauth2\/v1\/token$/

export function isTokenCall(call: RecordedCall): boolean {
  return TOKEN_RE.test(call.url)
}

/** Every call that is not the token exchange — the real work against the tenant. */
export function vendorCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isTokenCall(call))
}

/** Calls that change tenant state. A read-only handler must make none. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return vendorCalls(calls).filter((call) => call.method !== 'GET')
}

/** The ZIA activation POST, which commits every staged write. */
export function activateCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.url.includes('/zia/api/v1/status/activate'))
}

/**
 * Calls against the configuration resources themselves — neither the token
 * exchange nor ZIA's activation POST. "Made no change" means none of THESE:
 * a ZIA rollback with nothing to undo still activates, and counting that as a
 * write would make the assertion untestable.
 */
export function resourceCalls(calls: RecordedCall[]): RecordedCall[] {
  return vendorCalls(calls).filter((call) => !call.url.includes('/zia/api/v1/status/activate'))
}

/** Resource calls that change tenant state. */
export function resourceWrites(calls: RecordedCall[]): RecordedCall[] {
  return resourceCalls(calls).filter((call) => call.method !== 'GET')
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

/** True when the access token or the client secret appears anywhere in `value`. */
export function leaksSecret(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(ACCESS_TOKEN) || json.includes(CLIENT_SECRET)
}

export interface AssertLike {
  ok: (v: unknown, m?: string) => void
  equal: (a: unknown, b: unknown, m?: string) => void
}

/**
 * Assert the token exchange happened BEFORE the first tenant call and that every
 * later call carried the bearer token. Returns the non-token calls so a test can
 * go on asserting the request sequence.
 */
export function assertAuthenticatedFirst(assert: AssertLike, calls: RecordedCall[]): RecordedCall[] {
  assert.ok(calls.length > 0, 'handler made no call at all')
  assert.ok(isTokenCall(calls[0]), `first call must be the token exchange, was ${calls[0].url}`)
  assert.equal(calls[0].method, 'POST', 'the token exchange is a POST')
  for (const call of vendorCalls(calls)) {
    assert.equal(
      call.authorization,
      `Bearer ${ACCESS_TOKEN}`,
      `tenant call without the bearer token: ${call.method} ${call.url}`,
    )
  }
  return vendorCalls(calls)
}

// --- Canvas + context ---------------------------------------------------------

/** Shorthand for one canvas item. `fields` is flat across presentational groups. */
export function item(name: string, fields: Record<string, unknown> = {}, id?: string): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'zscaler'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 3,
    name: 'Test Canvas',
    toolType: 'zscaler',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

/** A working OneAPI credential: client id in `username`, secret in `apiToken`. */
export const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'Zscaler OneAPI client',
  username: CLIENT_ID,
  password: '',
  apiToken: CLIENT_SECRET,
  certificate: null,
}

/** A credential whose secret fields are blank — present, but unusable. */
export const EMPTY_CREDENTIAL: CredentialRef = {
  id: 'cred-blank',
  name: 'Zscaler OneAPI client (no secret)',
  username: CLIENT_ID,
  password: '',
  apiToken: '',
  certificate: null,
}

/**
 * A fresh Zidentity vanity domain per component.
 *
 * The token cache in `lib/zscaler.ts` is module-scope and keyed by vanity, so
 * reusing one across tests in the same bundled file would skip the token
 * exchange on every test after the first.
 */
let vanitySeq = 0
export function nextVanity(): string {
  vanitySeq += 1
  return `acme${vanitySeq}`
}

export function component(over: Partial<ComponentRef> = {}): ComponentRef {
  return {
    id: 'comp-1',
    hostname: `${nextVanity()}.zslogin.net`,
    port: '443',
    type: ['zscaler-tenant'],
    toolId: 'zscaler',
    ...over,
  }
}

/** Per-test overrides — everything else is a working connection to the tenant. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the defaults; `{}` models ZPA with no customer id configured. */
  settings?: Record<string, unknown>
  /** Replaces the component; `{ hostname: '' }` models an unregistered tenant. */
  component?: ComponentRef
  /** Components `getStatus` should see through `platform.listComponents`. */
  components?: ComponentRef[]
  /** The deployment record `platform.getLatestDeployment` should return. */
  latestDeployment?: DeploymentSummary | null
}

export function defaultSettings(): Record<string, unknown> {
  return { cloud: 'production', zpa_customer_id: ZPA_CUSTOMER_ID }
}

/** Settings with a credential-worthy cloud but NO ZPA customer id. */
export function settingsWithoutCustomerId(): Record<string, unknown> {
  return { cloud: 'production' }
}

function platformApi(over: ContextOverrides, components: ComponentRef[]): PlatformDataApi {
  return {
    getLatestDeployment: async () => over.latestDeployment ?? null,
    listComponents: async () => components,
  }
}

function baseContext(over: ContextOverrides) {
  const comp = over.component ?? component()
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zscaler',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: over.settings ?? defaultSettings(),
    platform: platformApi(over, over.components ?? [comp]),
    component: comp,
    credential: over.credential === undefined ? CREDENTIAL : over.credential,
    connectivity: null,
    connectivityProvider: null,
  }
}

export function deployContext(items: CanvasItemSnapshot[], over: ContextOverrides = {}): DeployContext {
  return {
    ...baseContext(over),
    canvas: canvas(items),
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
 * DESIRED state drift compares against — and is what every zscaler driftDetect
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
// platform's own deployment + component records through `ctx.platform`. It is
// byte-identical across all 33 configuration types in this app, so the contract
// that drives it lives in `zscalerContracts.ts`.

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

export interface StatusProbe {
  ctx: PipelineContext
  /** Each `getLatestDeployment` call, in order. */
  deploymentQueries: Array<{ canvasId: string; status?: string }>
  /** Each `listComponents` call, in order. */
  componentQueries: Array<{ types?: string[] }>
}

/**
 * Build a PipelineContext whose platform API returns `latest` and `components`,
 * recording every query the handler makes against it.
 */
export function statusContext(
  configTypeId: string,
  opts: {
    latest?: DeploymentSummary | null
    components?: ComponentRef[]
    version?: number
  } = {},
): StatusProbe {
  const deploymentQueries: StatusProbe['deploymentQueries'] = []
  const componentQueries: StatusProbe['componentQueries'] = []
  const comps = opts.components ?? [
    { id: 'comp-1', hostname: 'acme.zslogin.net', port: '443', type: ['zscaler-tenant'], toolId: 'zscaler' },
  ]

  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, args) => {
      deploymentQueries.push({ canvasId, status: args?.status })
      return opts.latest ?? null
    },
    listComponents: async (filter) => {
      componentQueries.push({ types: filter?.types })
      return comps
    },
  }

  const ctx = {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 3 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: defaultSettings(),
    platform,
    component: comps[0] ?? null,
    credential: CREDENTIAL as Cred,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries, componentQueries }
}
