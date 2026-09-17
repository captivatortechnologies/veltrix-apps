// =============================================================================
// Fake CrowdStrike Falcon — the shared vendor stub every handler test drives.
//
// `validate` was the only handler with tests in this app; the five that reach a
// customer's Falcon tenant (deploy, rollback, healthCheck, driftDetect) or the
// platform's own records (getStatus) had none across 44 configuration types.
// Every one of them reaches Falcon through `lib/falcon.ts`, which uses global
// `fetch`, so replacing `globalThis.fetch` with canned responses exercises a
// handler end to end — its OAuth2 token exchange, its request sequence, its
// bodies, its error handling and the rollback state it records — with no module
// mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// Five things about this app the harness has to account for:
//
//   * THE TOKEN CACHE IS MODULE-SCOPE. `lib/falcon.ts` caches the bearer token
//     in a `Map` keyed `<clientId>|<clientSecret>`, which outlives a single test
//     inside one bundled file. A second test reusing the same credential would
//     silently skip the token exchange and every queue-based fixture after it
//     would be off by one. So {@link credential} mints a FRESH client secret per
//     context — every handler invocation authenticates, exactly as a cold
//     platform worker would. The client ID stays fixed because drift
//     attribution excludes it as "our own deploy" identity.
//
//   * A 401 IS RETRIED. `FalconClient.request` treats a 401 as an expired cached
//     token: it drops the cache, re-authenticates and replays the request, which
//     costs a second token exchange AND a second vendor call. A queue fixture
//     for a 401 therefore needs four entries, not two — prefer {@link routeFetch}
//     there.
//
//   * FALCON RETURNS ERRORS ALONGSIDE HTTP 200. Every JSON endpoint answers with
//     the `{ meta, resources, errors }` envelope, and a write can half-fail with
//     a populated `errors[]` under a 200. `falconFailure()` is what a handler
//     must consult; {@link partialFailure} produces exactly that response so a
//     test can prove the handler does not read it as success.
//
//   * LOOKUPS ARE TWO CALLS. The entity/exclusion/FileVantage adapters do
//     `GET <queries>` (which answers with BARE ID STRINGS) and then
//     `GET <entity>?ids=…` (which answers with objects). {@link idsPage} and
//     {@link entityPage} produce one of each. The policy family instead reads
//     `GET <combined>` in a single call — {@link entityPage} serves that too.
//
//   * X-CS-REGION RE-HOMES THE CLIENT. `authenticate()` follows a region hint in
//     the token response ONCE, which costs an extra token exchange. The fake
//     returns no such header unless a test asks for one.
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
 * The bearer token the fake `/oauth2/token` endpoint hands out. Distinctive on
 * purpose: a result message, artifact, rollbackData or diff carrying this string
 * has leaked the tenant's Falcon access token.
 */
export const ACCESS_TOKEN = 'falcon-oauth2-access-token-MUST-NOT-LEAK'

/**
 * The stem of every API client secret the fake issues. The full secret carries a
 * per-context suffix (see {@link credential}), so leak detection matches the
 * stem rather than one exact value.
 */
export const CLIENT_SECRET_MARKER = 'falcon-api-client-secret-MUST-NOT-LEAK'

/**
 * The Falcon API client id. Fixed, because it is also the identity Veltrix's own
 * deploys are recorded under — `veltrixActorLogins()` excludes it from drift
 * attribution, and a test that proves that needs to know it.
 */
export const CLIENT_ID = 'veltrix-falcon-api-client-77aa31'

/** The trace id every fake envelope carries. Falcon support asks for it. */
export const TRACE_ID = 'f4c0-7r4c3-1d'

// --- The fake transport -------------------------------------------------------

/** One outbound request the handler made, as the fake saw it. */
export interface RecordedCall {
  url: string
  method: string
  /** The serialised JSON request body, or '' for a body-less/multipart request. */
  body: string
  /** The multipart body, for the endpoints that accept only `FormData`. */
  form: FormData | null
  /** The `Authorization` header — Falcon wants `Bearer <token>`. */
  authorization: string | null
  contentType: string | null
}

/** One canned Falcon response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** Value for `X-Cs-Region` — only read on the token exchange. */
  region?: string
  /** Value for `X-RateLimit-RetryAfter`, in EPOCH SECONDS — only read on a 429. */
  retryAfterEpochSeconds?: number
}

export interface FakeFalcon {
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
        if (key === 'x-cs-region') return next.region ?? null
        if (key === 'x-ratelimit-retryafter') {
          return next.retryAfterEpochSeconds === undefined
            ? null
            : String(next.retryAfterEpochSeconds)
        }
        if (key === 'content-type') return 'application/json'
        return null
      },
    },
    text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
  }
}

function install(pick: (url: string, method: string) => CannedResponse): FakeFalcon {
  const calls: RecordedCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body
    calls.push({
      url,
      method,
      body: typeof body === 'string' ? body : '',
      form: typeof FormData !== 'undefined' && body instanceof FormData ? body : null,
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
 * empty envelope, so an optional trailing listing never needs fixturing.
 *
 * The FIRST response a handler consumes is always the token exchange, because
 * {@link credential} hands every context a secret the token cache has never
 * seen.
 */
export function recordFetch(responses: CannedResponse[]): FakeFalcon {
  const queue = [...responses]
  return install(() => queue.shift() ?? EMPTY)
}

/** One URL-matched rule for {@link routeFetch}. */
export interface Route {
  /** Matched against the full request URL. */
  url: RegExp
  /** Optional method filter, for an endpoint whose GET and POST differ. */
  method?: string
  /** A single response reused for every match, or a queue consumed in order. */
  respond: CannedResponse | CannedResponse[]
}

/**
 * URL-matched variant of {@link recordFetch}. Prefer it whenever the handler's
 * exact call count is not the point of the test — above all for a 401, which
 * `FalconClient` silently retries (dropping its cached token first), so the real
 * sequence is token, call, token, call and a two-entry queue would feed the
 * retry an unrelated response.
 *
 * Routes are tried in order, so put the more specific pattern first. The token
 * endpoint is served automatically unless a route claims it — which is how a
 * test injects a token failure. Anything unmatched gets `fallback`.
 */
export function routeFetch(routes: Route[], fallback: CannedResponse = EMPTY): FakeFalcon {
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

/** The successful OAuth2 client-credentials response. Falcon answers 201. */
export const TOKEN: CannedResponse = {
  status: 201,
  body: { access_token: ACCESS_TOKEN, expires_in: 1799, token_type: 'bearer' },
}

/** A rejected token exchange — a bad client id/secret, or the wrong cloud. */
export function tokenError(
  message = 'access denied, authorization failed',
  status = 401,
): CannedResponse {
  return { status, body: { meta: { trace_id: TRACE_ID }, errors: [{ code: status, message }] } }
}

/** An empty `{ meta, resources }` envelope — a collection with nothing in it. */
export const EMPTY: CannedResponse = {
  status: 200,
  body: { meta: { trace_id: TRACE_ID, pagination: { offset: 0, limit: 500, total: 0 } }, resources: [] },
}

/**
 * One page of a Falcon id query (`GET <queries>`), which answers with BARE ID
 * STRINGS. The adapters stop paging as soon as a page is shorter than 500, so a
 * realistic fixture is a single page.
 */
export function idsPage(ids: string[]): CannedResponse {
  return {
    status: 200,
    body: {
      meta: { trace_id: TRACE_ID, pagination: { offset: 0, limit: 500, total: ids.length } },
      resources: ids,
    },
  }
}

/**
 * A `GET <entity>?ids=…` / `GET <combined>` response, which answers with full
 * objects rather than ids.
 */
export function entityPage(entities: unknown[]): CannedResponse {
  return {
    status: 200,
    body: {
      meta: { trace_id: TRACE_ID, pagination: { offset: 0, limit: 500, total: entities.length } },
      resources: entities,
    },
  }
}

/**
 * A create response carrying the new object. Most Falcon create endpoints answer
 * `resources: [{ id, … }]`.
 */
export function created(entity: unknown): CannedResponse {
  return { status: 201, body: { meta: { trace_id: TRACE_ID }, resources: [entity] } }
}

/**
 * A create response carrying the new id as a BARE STRING. Cloud Groups'
 * `CreateCloudGroupExternal` answers this way, unlike the rest of the catalog.
 */
export function createdId(id: string): CannedResponse {
  return { status: 201, body: { meta: { trace_id: TRACE_ID }, resources: [id] } }
}

/**
 * A create response that succeeded at the HTTP level but carries NO id. The
 * object exists in the tenant; the handler cannot record it. Deliberately
 * separate from {@link created} because this is the shape that exposes rollback
 * state recorded after the create rather than before it.
 */
export const CREATED_WITHOUT_ID: CannedResponse = {
  status: 201,
  body: { meta: { trace_id: TRACE_ID }, resources: [{}] },
}

/** A plain acknowledgement — what a PATCH/DELETE answers with. */
export function ok(body: unknown = { meta: { trace_id: TRACE_ID }, resources: [] }): CannedResponse {
  return { status: 200, body }
}

/** A Falcon error envelope at the given status. */
export function falconError(status: number, message: string, code = status): CannedResponse {
  return { status, body: { meta: { trace_id: TRACE_ID }, errors: [{ code, message }] } }
}

/**
 * HTTP 200 WITH a populated `errors[]` — Falcon's partial failure. A handler
 * that checks `res.ok` alone reads this as a success and reports a deploy that
 * changed nothing as done.
 */
export function partialFailure(
  message = 'access denied, authorization failed for one or more ids',
  resources: unknown[] = [],
): CannedResponse {
  return {
    status: 200,
    body: { meta: { trace_id: TRACE_ID }, resources, errors: [{ code: 403, message }] },
  }
}

/** The tenant rejecting the bearer token. NOTE: `FalconClient` retries a 401 once. */
export function unauthorized(message = 'access denied, authorization failed'): CannedResponse {
  return falconError(401, message)
}

/** The API client lacking the scope the endpoint needs. */
export function forbidden(message = 'access denied, authorization failed'): CannedResponse {
  return falconError(403, message)
}

/** The vendor being unable to answer — the case a handler must not read as "empty". */
export function serverError(message = 'internal server error'): CannedResponse {
  return falconError(500, message)
}

/** Not found — a KNOWN answer, unlike a 5xx. */
export function notFound(message = 'resource not found'): CannedResponse {
  return falconError(404, message)
}

/**
 * The per-tenant rate limit. No `X-RateLimit-RetryAfter` header, so
 * `FalconClient` does not wait and retry — the response reaches the handler.
 */
export function rateLimited(): CannedResponse {
  return falconError(429, 'API rate limit exceeded')
}

// --- Call predicates ----------------------------------------------------------

const TOKEN_RE = /\/oauth2\/token$/

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

/** Vendor calls filtered by method — `POST` for creates, `PATCH` for updates. */
export function callsOfMethod(calls: RecordedCall[], method: string): RecordedCall[] {
  return vendorCalls(calls).filter((call) => call.method === method)
}

/** A readable one-line summary of a call list, for assertion failure messages. */
export function describeCalls(calls: RecordedCall[]): string {
  return calls.map((call) => `${call.method} ${call.url}`).join(', ') || '(none)'
}

/** Parse a recorded JSON request body. Returns null for a body-less request. */
export function bodyOf(call: RecordedCall | undefined): Record<string, unknown> | null {
  if (!call || !call.body) return null
  try {
    return JSON.parse(call.body) as Record<string, unknown>
  } catch {
    return null
  }
}

/** A string field of a recorded multipart body. */
export function formField(call: RecordedCall | undefined, key: string): string | null {
  const value = call?.form?.get(key)
  return typeof value === 'string' ? value : null
}

/** The uploaded filename for a multipart file part. */
export function formFileName(call: RecordedCall | undefined, key: string): string | null {
  const value = call?.form?.get(key)
  return value && typeof value !== 'string' ? ((value as File).name ?? null) : null
}

/** The uploaded content of a multipart file part. */
export async function formFileText(
  call: RecordedCall | undefined,
  key: string,
): Promise<string | null> {
  const value = call?.form?.get(key)
  if (!value || typeof value === 'string') return null
  return (value as Blob).text()
}

/** True when the access token or an API client secret appears anywhere in `value`. */
export function leaksSecret(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(ACCESS_TOKEN) || json.includes(CLIENT_SECRET_MARKER)
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
  assert.equal(calls[0].method, 'POST', 'the OAuth2 token exchange is a POST')
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

/**
 * Shorthand for one canvas item. `fields` is flat across presentational groups —
 * every extractor in this app reads `item.fields`, never a nested structure.
 */
export function item(
  name: string,
  fields: Record<string, unknown> = {},
  id?: string,
): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'crowdstrike-edr'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 3,
    name: 'Test Canvas',
    toolType: 'crowdstrike-edr',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

/**
 * A fresh API client secret per credential.
 *
 * The token cache in `lib/falcon.ts` is module-scope and keyed
 * `<clientId>|<clientSecret>`, so reusing one credential across tests in the
 * same bundled file would skip the token exchange on every test after the first.
 * The client ID is deliberately NOT rotated — drift attribution excludes it.
 */
let secretSeq = 0
export function nextClientSecret(): string {
  secretSeq += 1
  return `${CLIENT_SECRET_MARKER}-${secretSeq}`
}

/** A working Falcon API client: client id in `username`, secret in `apiToken`. */
export function credential(over: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'Falcon API client',
    username: CLIENT_ID,
    password: '',
    apiToken: nextClientSecret(),
    certificate: null,
    ...over,
  }
}

/**
 * A credential whose secret fields are blank — the row exists, but
 * client-credentials has nothing to present, so there is nothing to try.
 */
export function emptyCredential(): CredentialRef {
  return credential({ apiToken: '', password: '' })
}

/** A credential with a secret but no client id. Equally unusable. */
export function credentialWithoutClientId(): CredentialRef {
  return credential({ username: '' })
}

export function component(over: Partial<ComponentRef> = {}): ComponentRef {
  return {
    id: 'comp-1',
    hostname: 'api.crowdstrike.com',
    port: '443',
    type: ['falcon-tenant'],
    toolId: 'crowdstrike-edr',
    ...over,
  }
}

/** Per-test overrides — everything else is a working connection to the tenant. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the defaults. */
  settings?: Record<string, unknown>
  /** Replaces the component — e.g. `{ hostname: 'eu-1' }` for a regional tenant. */
  component?: ComponentRef
  /** Components `getStatus` should see through `platform.listComponents`. */
  components?: ComponentRef[]
  /** The deployment record `platform.getLatestDeployment` should return. */
  latestDeployment?: DeploymentSummary | null
  /** The canvas the handler reads, when it must differ from the deployed config. */
  canvasItems?: CanvasItemSnapshot[]
}

export function defaultSettings(): Record<string, unknown> {
  return { falcon_region: 'us-1', request_timeout_seconds: 30 }
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
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'crowdstrike-edr',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: over.settings ?? defaultSettings(),
    platform: platformApi(over, over.components ?? [comp]),
    component: comp,
    credential: over.credential === undefined ? credential() : over.credential,
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
    canvas: canvas(over.canvasItems ?? []),
    rollbackData,
    targetVersion: canvas(over.canvasItems ?? []),
  } as unknown as RollbackContext
}

export function healthContext(
  items: CanvasItemSnapshot[] = [],
  over: ContextOverrides = {},
): HealthCheckContext {
  return {
    ...baseContext(over),
    canvas: canvas(items),
  } as unknown as HealthCheckContext
}

/**
 * A drift context. `deployedItems` is what the last deploy recorded — the
 * DESIRED state drift compares against — and is what every crowdstrike-edr
 * driftDetect reads (`ctx.deployedConfig`), never `ctx.canvas`.
 */
export function driftContext(
  deployedItems: CanvasItemSnapshot[],
  over: ContextOverrides = {},
): DriftContext {
  return {
    ...baseContext(over),
    canvas: canvas(over.canvasItems ?? deployedItems),
    deployedConfig: canvas(deployedItems),
  } as unknown as DriftContext
}

// --- getStatus ----------------------------------------------------------------
// getStatus is the one handler that never touches the tenant: it reads the
// platform's own deployment + component records through `ctx.platform`. It is
// identical in all 44 configuration types in this app, so the contract that
// drives it lives in `falconContracts.ts`.

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
  const comps = opts.components ?? [component()]

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
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 3 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: defaultSettings(),
    platform,
    component: comps[0] ?? null,
    credential: credential(),
  } as unknown as PipelineContext

  return { ctx, deploymentQueries, componentQueries }
}
