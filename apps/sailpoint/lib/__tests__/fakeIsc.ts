// =============================================================================
// Fake SailPoint Identity Security Cloud — the shared vendor stub every ISC
// handler test drives.
//
// `validate` was the only handler with tests in this app; the five that actually
// change a customer's IDENTITY GOVERNANCE (deploy, rollback, healthCheck,
// driftDetect, getStatus) had none. Every handler here reaches ISC through
// `lib/isc.ts`, which uses global `fetch`, so replacing `globalThis.fetch` with
// a queue of canned responses drives a handler end to end — its OAuth2 token
// exchange, its request sequence, its bodies, its error handling and the
// rollback state it records — with no module mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// What ISC makes worth knowing when fixturing:
//   * every handler builds ONE IscClient per invocation and the client caches its
//     token, so the FIRST response consumed is always the token exchange;
//   * list endpoints return a BARE JSON array (not an envelope) and paginate with
//     `offset`/`limit`, capped at 250 — a page shorter than the limit ends it;
//   * `IscClient.request` never throws on an HTTP status, so a handler that
//     "fails" still returns a result the operator can read;
//   * neither the bearer token nor the OAuth client secret may appear in a
//     message, artifact, rollbackData or diff.
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

// --- The fake transport -------------------------------------------------------

/** One outbound request the handler made, as the fake saw it. */
export interface RecordedCall {
  url: string
  method: string
  /** The serialised request body, or '' for a body-less request. */
  body: string
  /** The `Authorization` header — ISC data routes want `Bearer <token>`. */
  authorization: string | null
  /** `application/json`, or `application/json-patch+json` for a JSON-Patch write. */
  contentType: string | null
}

/** One canned ISC response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** Value for the `Retry-After` header, in seconds — only read on a 429. */
  retryAfter?: string
  /** Value for `X-Total-Count`, which `count=true` listings read. */
  totalCount?: string
}

export interface FakeIsc {
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
        if (key === 'x-total-count') return next.totalCount ?? null
        return 'application/json'
      },
    },
    text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
  }
}

function record(
  calls: RecordedCall[],
  input: unknown,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): { url: string; method: string } {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({
    url,
    method,
    body: typeof init?.body === 'string' ? init.body : '',
    authorization: init?.headers?.Authorization ?? null,
    contentType: init?.headers?.['Content-Type'] ?? null,
  })
  return { url, method }
}

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 * Responses are consumed in order; a request past the end of the queue gets an
 * empty ISC list (a bare `[]`), so an optional trailing listing never needs
 * fixturing and a paginating `getAll` always terminates.
 */
export function recordFetch(responses: CannedResponse[]): FakeIsc {
  const calls: RecordedCall[] = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    record(calls, input, init)
    return respond(queue.shift() ?? { status: 200, body: [] })
  }) as unknown as typeof globalThis.fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** One URL-matched rule for {@link routeFetch}. */
export interface Route {
  /** Matched against the full request URL. */
  url: RegExp
  /** Optional method filter, for an endpoint whose GET and write differ. */
  method?: string
  /** A single response reused for every match, or a queue consumed in order. */
  respond: CannedResponse | CannedResponse[]
}

/**
 * URL-matched variant of {@link recordFetch}, for the nested configuration types
 * that walk a parent listing and then one child listing per parent. A strict
 * response queue for those encodes an ordering the handler's own grouping
 * decides, so it can pass for the wrong reason; matching on the URL says what
 * each endpoint returns and leaves the sequencing to the handler.
 *
 * Routes are tried in order, so put the more specific pattern first. The token
 * endpoint is served automatically unless a route claims it — which is how a
 * test injects a token failure. Anything unmatched gets `fallback`.
 */
export function routeFetch(routes: Route[], fallback: CannedResponse = { status: 200, body: [] }): FakeIsc {
  const queues = new Map<Route, CannedResponse[]>()
  for (const route of routes) {
    if (Array.isArray(route.respond)) queues.set(route, [...route.respond])
  }

  const pick = (url: string, method: string): CannedResponse => {
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
  }

  const calls: RecordedCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    const { url, method } = record(calls, input, init)
    return respond(pick(url, method))
  }) as unknown as typeof globalThis.fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

// --- Secrets that must never escape ------------------------------------------

/**
 * The bearer token the fake token endpoint hands out. Distinctive on purpose: a
 * result message, artifact, rollbackData or diff carrying this string has leaked
 * the tenant's ISC access token.
 */
export const ACCESS_TOKEN = 'isc-access-token-MUST-NOT-LEAK'

/** The OAuth client secret (a PAT secret in practice) — equally must never surface. */
export const CLIENT_SECRET = 'isc-client-secret-MUST-NOT-LEAK'

export const CLIENT_ID = 'b4f1c0d2e3a45566778899aabbccddee'
export const TENANT = 'acme'
export const BASE_URL = `https://${TENANT}.api.identitynow.com`

/** The successful OAuth2 client-credentials response. */
export const TOKEN: CannedResponse = {
  status: 200,
  body: { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 43200 },
}

/** A rejected token exchange — ISC answers with `error`/`error_description`. */
export function tokenError(description = 'client authentication failed'): CannedResponse {
  return { status: 401, body: { error: 'invalid_client', error_description: description } }
}

// --- Canned ISC responses -----------------------------------------------------

/** One page of an ISC list endpoint: a BARE JSON array, not an envelope. */
export function listPage(items: unknown[]): CannedResponse {
  return { status: 200, body: items }
}

/** A single resource read. */
export function resource(body: unknown): CannedResponse {
  return { status: 200, body }
}

/** A plain 200 acknowledgement with an optional body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A 201 creation response carrying the created object. */
export function created(body: unknown = {}): CannedResponse {
  return { status: 201, body }
}

/** ISC's 204 for a successful write with no content. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }

/**
 * An ISC error body at the given status. ISC returns
 * `{ detailCode, trackingId, messages: [{ locale, text }] }`, which
 * `iscErrorMessage` renders as `detailCode: text`.
 */
export function iscError(status: number, text: string, detailCode = '403 Forbidden'): CannedResponse {
  return {
    status,
    body: { detailCode, trackingId: 'trk-1', messages: [{ locale: 'en-US', text }] },
  }
}

/** ISC's 404 for an absent object. */
export function notFound(text = 'Resource not found'): CannedResponse {
  return iscError(404, text, '404 Not Found')
}

// --- Call predicates ----------------------------------------------------------

const TOKEN_RE = /\/oauth\/token$/

export function isTokenCall(call: RecordedCall): boolean {
  return TOKEN_RE.test(call.url)
}

/** Every call that is not the token exchange — the real work against ISC. */
export function vendorCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isTokenCall(call))
}

/** Calls that change tenant state. A read-only handler must make none. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return vendorCalls(calls).filter((call) => call.method !== 'GET')
}

/** Vendor calls made with the given method. */
export function callsWithMethod(calls: RecordedCall[], method: string): RecordedCall[] {
  return vendorCalls(calls).filter((call) => call.method === method)
}

/** Parse a recorded request body. Returns null for a body-less request. */
export function bodyOf(call: RecordedCall | undefined): unknown {
  if (!call || !call.body) return null
  try {
    return JSON.parse(call.body) as unknown
  } catch {
    return null
  }
}

/** The path (and query) of a recorded call, with the tenant API base stripped. */
export function pathOf(call: RecordedCall): string {
  return call.url.startsWith(BASE_URL) ? call.url.slice(BASE_URL.length) : call.url
}

/** True when the access token or the client secret appears anywhere in `value`. */
export function leaksSecret(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(ACCESS_TOKEN) || json.includes(CLIENT_SECRET)
}

interface Asserter {
  ok: (v: unknown, m?: string) => void
  equal: (a: unknown, b: unknown, m?: string) => void
}

/**
 * Assert the token exchange happened first and that every later call carried the
 * bearer token. Returns the non-token calls so a test can go on asserting them.
 */
export function assertAuthenticatedFirst(assert: Asserter, calls: RecordedCall[]): RecordedCall[] {
  assert.ok(calls.length > 0, 'handler made no call at all')
  assert.ok(isTokenCall(calls[0]), `first call must be the token exchange, was ${calls[0].url}`)
  assert.equal(calls[0].method, 'POST', 'the token exchange is a POST')
  for (const call of vendorCalls(calls)) {
    assert.equal(
      call.authorization,
      `Bearer ${ACCESS_TOKEN}`,
      `ISC call without the bearer token: ${call.method} ${call.url}`,
    )
  }
  return vendorCalls(calls)
}

// --- Canvas + context ---------------------------------------------------------

/** Shorthand for one canvas item. */
export function item(name: string, fields: Record<string, unknown> = {}, id?: string): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'sailpoint'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 3,
    name: 'Test Canvas',
    toolType: 'sailpoint',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'ISC personal access token',
  username: CLIENT_ID,
  password: CLIENT_SECRET,
  apiToken: null,
  certificate: null,
}

/** Per-test overrides — everything else is a working connection to ISC. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the default `{ tenant }`; `{}` models a missing tenant setting. */
  settings?: Record<string, unknown>
  /** The rollbackData the previous SUCCEEDED deployment recorded, if any. */
  priorRollbackData?: unknown
  /** `true` makes the platform lookup throw, which deploy must absorb. */
  platformThrows?: boolean
  /** Canvas items for `deployedConfig`, when drift should see a different desired state. */
  deployedItems?: CanvasItemSnapshot[]
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

function platformApi(over: ContextOverrides): PlatformDataApi {
  return {
    getLatestDeployment: async () => {
      if (over.platformThrows) throw new Error('platform unavailable')
      return over.priorRollbackData === undefined
        ? null
        : deploymentSummary({ rollbackData: over.priorRollbackData })
    },
    listComponents: async () => [],
  }
}

export const COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: `${TENANT}.api.identitynow.com`,
  port: '443',
  type: ['sailpoint-tenant'],
  toolId: 'sailpoint',
}

function baseContext(over: ContextOverrides) {
  return {
    appId: 'sailpoint',
    customerId: 'cust-1',
    configTypeId: 'sailpoint',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: over.settings ?? { tenant: TENANT },
    platform: platformApi(over),
    component: COMPONENT,
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

export function healthContext(over: ContextOverrides = {}): HealthCheckContext {
  return {
    ...baseContext(over),
    canvas: canvas([]),
  } as unknown as HealthCheckContext
}

export function driftContext(items: CanvasItemSnapshot[], over: ContextOverrides = {}): DriftContext {
  return {
    ...baseContext(over),
    canvas: canvas(items),
    deployedConfig: canvas(over.deployedItems ?? items),
  } as unknown as DriftContext
}

// --- getStatus ----------------------------------------------------------------
// getStatus is the one handler that never touches ISC: it reads the platform's
// own deployment record through `ctx.platform`. It is identical across all 31
// configuration types in this app, so the contract is shared — see iscContracts.

export interface StatusProbe {
  ctx: PipelineContext
  /** Each `getLatestDeployment` call, in order. */
  deploymentQueries: Array<{ canvasId: string; status?: string }>
}

/**
 * Build a PipelineContext whose platform API returns `latest`, recording every
 * query the handler makes against it. `latest: 'throws'` models the platform
 * record being unreadable, which getStatus must absorb rather than propagate.
 */
export function statusContext(
  configTypeId: string,
  opts: {
    latest: DeploymentSummary | null | 'throws'
    component?: ComponentRef | null
    version?: number
  } = { latest: null },
): StatusProbe {
  const deploymentQueries: StatusProbe['deploymentQueries'] = []

  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, args) => {
      deploymentQueries.push({ canvasId, status: args?.status })
      if (opts.latest === 'throws') throw new Error('platform unavailable')
      return opts.latest
    },
    listComponents: async () => [],
  }

  const ctx = {
    appId: 'sailpoint',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 3 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant: TENANT },
    platform,
    component: opts.component === undefined ? COMPONENT : opts.component,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries }
}
