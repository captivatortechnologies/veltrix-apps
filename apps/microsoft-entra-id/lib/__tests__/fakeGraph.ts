// =============================================================================
// Fake Microsoft Graph — the shared vendor stub every Entra ID handler test drives.
//
// `validate` was the only handler with tests here; the five that actually change
// a customer's DIRECTORY (deploy, rollback, healthCheck, driftDetect, getStatus)
// had none. Every handler in this app reaches Graph through `lib/graph.ts`, which
// uses global `fetch`, so replacing `globalThis.fetch` with a queue of canned
// responses exercises a handler end to end — its token exchange, its request
// sequence, its bodies, its error handling and the rollback state it records —
// with no module mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// What this app makes worth asserting, beyond the usual:
//   * the OAuth2 client-credentials token is acquired BEFORE the first Graph
//     call, and neither the token nor the client secret appears in any message,
//     artifact, rollbackData or diff;
//   * a Conditional Access policy is never written in an ENABLED state by
//     accident — assert the `state` actually sent on the wire;
//   * rollback restores the LIVE prior state captured at deploy time, not the
//     desired canvas values;
//   * a failed listing stops the handler BEFORE it writes anything.
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
  /** The `Authorization` header — Graph wants `Bearer <token>`. */
  authorization: string | null
  contentType: string | null
  /** `Accept-Language`, which only organizational-branding's locale PUT sets. */
  acceptLanguage: string | null
}

/** One canned Graph response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** Value for the `Retry-After` header, in seconds — only read on a 429. */
  retryAfter?: string
}

export interface FakeGraph {
  calls: RecordedCall[]
  restore: () => void
}

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 * Responses are consumed in order; a request past the end of the queue gets an
 * empty OData collection, so an optional trailing listing never needs fixturing.
 *
 * The first response a handler consumes is ALWAYS the token exchange — GraphClient
 * calls `ensureToken()` before every request and caches per client instance, and a
 * handler builds one client per invocation.
 */
export function recordFetch(responses: CannedResponse[]): FakeGraph {
  const calls: RecordedCall[] = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: init?.headers?.Authorization ?? null,
      contentType: init?.headers?.['Content-Type'] ?? null,
      acceptLanguage: init?.headers?.['Accept-Language'] ?? null,
    })
    const next = queue.shift() ?? { status: 200, body: { value: [] } }
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          String(name).toLowerCase() === 'retry-after' ? (next.retryAfter ?? null) : 'application/json',
      },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    }
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
  /** Optional method filter, for an endpoint whose GET and POST differ. */
  method?: string
  /** A single response reused for every match, or a queue consumed in order. */
  respond: CannedResponse | CannedResponse[]
}

/**
 * URL-matched variant of {@link recordFetch}, for the handlers that build several
 * `displayName -> id` maps with `Promise.all`. A strict response QUEUE encodes an
 * ordering those parallel listings do not actually guarantee, so a queue-based
 * fixture for them is a test that can pass for the wrong reason; matching on the
 * URL says what each endpoint returns and leaves the ordering to the handler.
 *
 * Routes are tried in order, so put the more specific pattern first. The token
 * endpoint is served automatically unless a route claims it — which is how a test
 * injects a token failure. Anything unmatched gets `fallback`.
 */
export function routeFetch(routes: Route[], fallback: CannedResponse = { status: 200, body: { value: [] } }): FakeGraph {
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
      // so an extra poll never silently becomes an empty collection.
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
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: init?.headers?.Authorization ?? null,
      contentType: init?.headers?.['Content-Type'] ?? null,
      acceptLanguage: init?.headers?.['Accept-Language'] ?? null,
    })
    const next = pick(url, method)
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          String(name).toLowerCase() === 'retry-after' ? (next.retryAfter ?? null) : 'application/json',
      },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    }
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
 * the directory's app-only access token.
 */
export const ACCESS_TOKEN = 'graph-access-token-MUST-NOT-LEAK'

/** The app registration's client secret — equally must never surface. */
export const CLIENT_SECRET = 'entra-client-secret-MUST-NOT-LEAK'

export const TENANT_ID = '9f3c7a21-4b2e-4d6a-8c11-2a7e5f0b9d43'
export const CLIENT_ID = '00000000-1111-2222-3333-444444444444'

/** The successful OAuth2 client-credentials response. */
export const TOKEN: CannedResponse = {
  status: 200,
  body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' },
}

/** A rejected token exchange — Entra answers with `error`/`error_description`. */
export function tokenError(description = 'AADSTS7000215: Invalid client secret provided'): CannedResponse {
  return { status: 401, body: { error: 'invalid_client', error_description: description } }
}

// --- Canned Graph responses ---------------------------------------------------

/** An OData collection envelope: `{ value: [...] }`. */
export function collection(items: unknown[]): CannedResponse {
  return { status: 200, body: { value: items } }
}

/** One page of an OData collection, with an `@odata.nextLink` to the next. */
export function page(items: unknown[], nextLink: string): CannedResponse {
  return { status: 200, body: { value: items, '@odata.nextLink': nextLink } }
}

/** A single resource read (`GET /policies/authorizationPolicy`). */
export function resource(body: unknown): CannedResponse {
  return { status: 200, body }
}

/** A Graph error body (`{ error: { code, message } }`) at the given status. */
export function graphError(status: number, message: string, code = 'Authorization_RequestDenied'): CannedResponse {
  return { status, body: { error: { code, message } } }
}

/** A plain 200 acknowledgement with an optional body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A 201 creation response carrying the created object. */
export function created(body: unknown = {}): CannedResponse {
  return { status: 201, body }
}

/** Graph's 204 for a successful PATCH/DELETE with no content. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }

/** Graph's 404 for an absent object. */
export function notFound(message = 'Resource not found'): CannedResponse {
  return graphError(404, message, 'Request_ResourceNotFound')
}

// --- Call predicates ----------------------------------------------------------

const TOKEN_RE = /login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/

export function isTokenCall(call: RecordedCall): boolean {
  return TOKEN_RE.test(call.url)
}

/** Every call that is not the token exchange — the real work against Graph. */
export function vendorCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isTokenCall(call))
}

/** Calls that change directory state. A read-only handler must make none. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return vendorCalls(calls).filter((call) => call.method !== 'GET')
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

/**
 * Assert the token exchange happened first and that every later call carried the
 * bearer token. Returns the non-token calls so a test can go on asserting them.
 */
export function assertAuthenticatedFirst(
  assert: { ok: (v: unknown, m?: string) => void; equal: (a: unknown, b: unknown, m?: string) => void },
  calls: RecordedCall[],
): RecordedCall[] {
  assert.ok(calls.length > 0, 'handler made no call at all')
  assert.ok(isTokenCall(calls[0]), `first call must be the token exchange, was ${calls[0].url}`)
  assert.equal(calls[0].method, 'POST', 'the token exchange is a POST')
  for (const call of vendorCalls(calls)) {
    assert.equal(
      call.authorization,
      `Bearer ${ACCESS_TOKEN}`,
      `Graph call without the bearer token: ${call.method} ${call.url}`,
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
export function canvas(items: CanvasItemSnapshot[], entityType = 'entra'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 3,
    name: 'Test Canvas',
    toolType: 'microsoft-entra-id',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'Entra app registration',
  username: CLIENT_ID,
  password: CLIENT_SECRET,
  apiToken: null,
  certificate: null,
}

/** Per-test overrides — everything else is a working connection to Graph. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the default `{ tenant_id }`; `{}` models a missing tenant setting. */
  settings?: Record<string, unknown>
  /** The rollbackData the previous SUCCEEDED deployment recorded, if any. */
  priorRollbackData?: unknown
  /** Canvas items for `deployedConfig`, when drift should see a different desired state. */
  deployedItems?: CanvasItemSnapshot[]
}

function platformApi(over: ContextOverrides): PlatformDataApi {
  return {
    getLatestDeployment: async () =>
      over.priorRollbackData === undefined
        ? null
        : deploymentSummary({ rollbackData: over.priorRollbackData }),
    listComponents: async () => [],
  }
}

export const COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: 'graph.microsoft.com',
  port: '443',
  type: ['microsoft-entra-id'],
  toolId: 'microsoft-entra-id',
}

function baseContext(over: ContextOverrides) {
  return {
    appId: 'microsoft-entra-id',
    customerId: 'cust-1',
    configTypeId: 'microsoft-entra-id',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: over.settings ?? { tenant_id: TENANT_ID },
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
// getStatus is the one handler that never touches Graph: it reads the platform's
// own deployment record through `ctx.platform`. It is byte-identical across all
// 42 configuration types in this app, so the contract below is shared.

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
    appId: 'microsoft-entra-id',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 3 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: TENANT_ID },
    platform,
    component: opts.component === undefined ? COMPONENT : opts.component,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries }
}
