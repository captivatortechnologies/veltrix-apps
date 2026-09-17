// =============================================================================
// Fake IBM QRadar REST API — the shared vendor stub every QRadar handler test
// drives.
//
// `validate` was the only handler with tests in this app; the five that reach a
// customer's QRadar console (deploy, rollback, healthCheck, driftDetect) or the
// platform's own records (getStatus) had none. Every handler here reaches the
// console through `lib/qradar.ts`, which uses global `fetch`, so replacing
// `globalThis.fetch` with canned responses exercises a handler end to end — its
// request sequence, its headers, its bodies, its error handling and the
// rollback state it records — with no module mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// Four things about this app the harness has to account for:
//
//   * THERE IS NO TOKEN EXCHANGE. QRadar authenticates every request with the
//     authorized-service token in the `SEC` header — there is no login round
//     trip to fixture, so the FIRST response in a queue is the handler's first
//     real request. What replaces "authenticated before its first call" here is
//     {@link assertQRadarHeaders}: every call must carry the SEC token and the
//     DECLARED API version.
//
//   * THE API VERSION IS A HEADER, AND IT IS A SETTING. `lib/qradar.ts` sends
//     `Version: <api_version>` and defaults to 20.0. {@link defaultSettings}
//     declares {@link API_VERSION} (19.0) precisely because it is NOT the
//     default — a handler that dropped the header, or hard-coded 20.0, fails.
//
//   * A FAILED REQUEST NEVER THROWS. `QRadarClient.request` catches transport
//     errors and returns `{ status: 0, ok: false, transportError }`, so a
//     handler sees a failed response rather than a rejected promise. Use
//     {@link transportFailure} to reach that path.
//
//   * READS ARE RANGE-PAGED. Every list GET carries `Range: items=0-9999` (or
//     `items=0-0` for a health probe). The fake records the header so a test can
//     assert the handler asked for the whole list rather than the first page.
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

// --- Secrets and identity that must never escape ------------------------------

/**
 * The authorized-service token the credential carries, sent in the `SEC` header.
 * Distinctive on purpose: a result message, artifact, rollbackData or diff
 * carrying this string has leaked the customer's QRadar admin token.
 */
export const SEC_TOKEN = 'qradar-sec-authorized-service-token-MUST-NOT-LEAK'

/** The QRadar console host, supplied as the `console_host` app setting. */
export const CONSOLE_HOST = 'qradar.example.test'

/** The base every request is built on: `https://<console>/api...`. */
export const BASE_URL = `https://${CONSOLE_HOST}/api`

/**
 * The declared API version, supplied as the `api_version` app setting.
 *
 * Deliberately NOT `lib/qradar.ts`'s 20.0 default, so a handler that fails to
 * send the header — or sends a hard-coded version — is caught.
 */
export const API_VERSION = '19.0'

// --- The fake transport -------------------------------------------------------

/** One outbound request the handler made, as the fake saw it. */
export interface RecordedCall {
  url: string
  method: string
  /** The serialised request body, or '' for a body-less request. */
  body: string
  /** The `SEC` header — QRadar's authorized-service token. */
  sec: string | null
  /** The `Version` header — the API version the app declared. */
  version: string | null
  /** The `Range` header, present on list reads. */
  range: string | null
  contentType: string | null
}

/** One canned QRadar response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** When set, `fetch` REJECTS with this message instead of answering. */
  transportError?: string
}

export interface FakeQRadar {
  calls: RecordedCall[]
  restore: () => void
}

function respond(next: CannedResponse) {
  const status = next.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
  }
}

function install(pick: (url: string, method: string) => CannedResponse): FakeQRadar {
  const calls: RecordedCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = init?.headers ?? {}
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : '',
      sec: headers.SEC ?? null,
      version: headers.Version ?? null,
      range: headers.Range ?? null,
      contentType: headers['Content-Type'] ?? null,
    })
    const next = pick(url, method)
    if (next.transportError) throw new Error(next.transportError)
    return respond(next)
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
 * empty JSON array, so an optional trailing listing never needs fixturing.
 *
 * With no token exchange in front of it, queue position 0 is the handler's first
 * real request.
 */
export function recordFetch(responses: CannedResponse[]): FakeQRadar {
  const queue = [...responses]
  return install(() => queue.shift() ?? { status: 200, body: [] })
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
 * exact call COUNT is not the point of the test — above all for the deploys
 * that fan out over several lookup endpoints in `Promise.all`, where the order
 * a queue would impose is an implementation detail rather than a contract.
 *
 * Routes are tried in order, so put the more specific pattern first. Anything
 * unmatched gets `fallback`.
 */
export function routeFetch(
  routes: Route[],
  fallback: CannedResponse = { status: 200, body: [] },
): FakeQRadar {
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
      // so an extra poll never silently becomes an unrelated fallback.
      return queue.length > 1 ? (queue.shift() as CannedResponse) : (queue[0] ?? fallback)
    }
    return fallback
  })
}

// --- Canned responses ---------------------------------------------------------

/** A plain 200 with an optional body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A 201 create response carrying the created object. */
export function created(body: unknown): CannedResponse {
  return { status: 201, body }
}

/** A 200 list response. QRadar list endpoints return a bare JSON array. */
export function list(items: unknown[]): CannedResponse {
  return { status: 200, body: items }
}

/** QRadar's 202 for an accepted asynchronous delete / deploy. */
export const ACCEPTED: CannedResponse = { status: 202, body: {} }

/** A 204 for a successful DELETE. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }

/**
 * A QRadar error body at the given status. QRadar answers
 * `{ message, code, description, http_response: { code } }` and
 * `qradarErrorMessage` prefers `description`.
 */
export function qradarError(status: number, description: string, code = 1005): CannedResponse {
  return {
    status,
    body: { message: description, code, description, http_response: { code: status, message: description } },
  }
}

/**
 * Not found — a KNOWN answer, unlike a 5xx.
 *
 * The `code` here is an arbitrary fixture value, not a documented QRadar
 * mapping. It is deliberately NOT 1002: `deployStagedConfig` treats code 1002 as
 * "a deploy is already in progress" at ANY status, so reusing it here would make
 * every 404 in this suite look like a successful staged deploy and quietly bless
 * that guard.
 */
export function notFound(description = 'The requested object was not found'): CannedResponse {
  return qradarError(404, description, 1004)
}

/** The console rejecting the token or the authorized service's role. */
export function unauthorized(description = 'SEC header is invalid or the service is not authorized'): CannedResponse {
  return qradarError(401, description, 1010)
}

/** The role lacks the admin capability the endpoint needs. */
export function forbidden(description = 'You do not have the required capability for this endpoint'): CannedResponse {
  return qradarError(403, description, 1009)
}

/** The console being unable to answer — the case a read must not treat as "empty". */
export function serverError(description = 'An internal server error occurred'): CannedResponse {
  return qradarError(500, description, 1020)
}

/**
 * QRadar rejecting a concurrent staged deploy (single-flight): 409 with code
 * 1002, which `deployStagedConfig` treats as success because the in-flight
 * deploy will apply whatever is currently staged.
 */
export function deployInProgress(): CannedResponse {
  return qradarError(409, 'A deploy is already in progress', 1002)
}

/** The console unreachable at the transport layer (TLS, DNS, timeout). */
export function transportFailure(message = 'getaddrinfo ENOTFOUND qradar.example.test'): CannedResponse {
  return { transportError: message }
}

// --- Call predicates ----------------------------------------------------------

/** The path portion of a recorded call, with the `https://host/api` base removed. */
export function pathOf(call: RecordedCall | undefined): string {
  if (!call) return ''
  return call.url.startsWith(BASE_URL) ? call.url.slice(BASE_URL.length) : call.url
}

/** Calls that change console state. A read-only handler must make none. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
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

/** Parse a recorded request body that is a JSON ARRAY (a whole-list PUT). */
export function arrayBodyOf(call: RecordedCall | undefined): unknown[] | null {
  if (!call || !call.body) return null
  try {
    const parsed = JSON.parse(call.body) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** True when the authorized-service token appears anywhere in `value`. */
export function leaksToken(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(SEC_TOKEN)
}

export interface AssertLike {
  ok: (v: unknown, m?: string) => void
  equal: (a: unknown, b: unknown, m?: string) => void
}

/**
 * Assert every call carried the SEC token and the DECLARED API version, and was
 * addressed to the console's `/api` base. Returns the calls so a test can go on
 * asserting the request sequence.
 *
 * QRadar has no login round trip, so this is what "authenticates before its
 * first real request" means for this app.
 */
export function assertQRadarHeaders(assert: AssertLike, calls: RecordedCall[]): RecordedCall[] {
  assert.ok(calls.length > 0, 'handler made no call at all')
  for (const call of calls) {
    assert.equal(call.sec, SEC_TOKEN, `console call without the SEC token: ${call.method} ${call.url}`)
    assert.equal(
      call.version,
      API_VERSION,
      `console call without the declared API version: ${call.method} ${call.url}`,
    )
    assert.ok(call.url.startsWith(`${BASE_URL}/`), `call outside the console API base: ${call.url}`)
  }
  return calls
}

// --- Canvas + context ---------------------------------------------------------

/** Shorthand for one canvas item. `fields` is flat across presentational groups. */
export function item(name: string, fields: Record<string, unknown> = {}, id?: string): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'ibm-qradar'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 4,
    name: 'Test Canvas',
    toolType: 'ibm-qradar',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

export function component(over: Partial<ComponentRef> = {}): ComponentRef {
  return {
    id: 'comp-1',
    hostname: CONSOLE_HOST,
    port: '443',
    type: ['qradar-console'],
    toolId: 'ibm-qradar',
    ...over,
  }
}

/** A working credential: the SEC token in `password`, which is the convention. */
export const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'QRadar authorized service',
  username: '',
  password: SEC_TOKEN,
  apiToken: null,
  certificate: null,
}

// NOTE: `lib/qradar.ts` documents a fallback to the token stored in `username`,
// but reads it as `credential.password ?? credential.username` — and the
// platform always supplies `password` as a string, so an empty password is ''
// rather than nullish and the fallback never fires. There is deliberately no
// fixture for that shape here: a test asserting the refusal would document the
// bug as correct. It is in the defect report instead.

/** A credential row that exists but carries no token — present, but unusable. */
export const EMPTY_CREDENTIAL: CredentialRef = {
  id: 'cred-blank',
  name: 'QRadar authorized service (no token)',
  username: '',
  password: '   ',
  apiToken: null,
  certificate: null,
}

/** The app settings for a working console connection. */
export function defaultSettings(): Record<string, unknown> {
  return { console_host: CONSOLE_HOST, api_version: API_VERSION, request_timeout_seconds: 30 }
}

/** Settings with an API version but NO console host — nothing to address. */
export function settingsWithoutHost(): Record<string, unknown> {
  return { api_version: API_VERSION, request_timeout_seconds: 30 }
}

/** Per-test overrides — everything else is a working connection to the console. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the defaults; {@link settingsWithoutHost} models a missing console. */
  settings?: Record<string, unknown>
  /** Replaces the component. */
  component?: ComponentRef
  /** Components `getStatus` should see through `platform.listComponents`. */
  components?: ComponentRef[]
  /** The deployment record `platform.getLatestDeployment` should return. */
  latestDeployment?: DeploymentSummary | null
  /**
   * The rollbackData the PREVIOUS successful deployment recorded. Every deploy
   * in this app reads it through `loadPriorEntries` to know which objects it
   * created before, and therefore which to reconcile-delete.
   */
  priorRollbackData?: unknown
  /** Make `platform.getLatestDeployment` reject, to exercise the catch. */
  platformFails?: boolean
}

function platformApi(over: ContextOverrides, components: ComponentRef[]): PlatformDataApi {
  return {
    getLatestDeployment: async () => {
      if (over.platformFails) throw new Error('platform data unavailable')
      if (over.latestDeployment !== undefined) return over.latestDeployment
      if (over.priorRollbackData !== undefined) {
        return deploymentSummary({ rollbackData: over.priorRollbackData })
      }
      return null
    },
    listComponents: async () => components,
  }
}

function baseContext(over: ContextOverrides) {
  const comp = over.component ?? component()
  return {
    appId: 'ibm-qradar',
    customerId: 'cust-1',
    configTypeId: 'ibm-qradar',
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
 * DESIRED state drift compares against — and is what every QRadar driftDetect
 * reads (`ctx.deployedConfig`), never `ctx.canvas`. The canvas is deliberately
 * given DIFFERENT items so a handler that read the wrong one is caught.
 */
export function driftContext(deployedItems: CanvasItemSnapshot[], over: ContextOverrides = {}): DriftContext {
  return {
    ...baseContext(over),
    canvas: canvas([item('canvas-only-item-the-handler-must-not-read', { name: 'wrong-source' })]),
    deployedConfig: canvas(deployedItems),
  } as unknown as DriftContext
}

// --- getStatus ----------------------------------------------------------------
// getStatus is the one handler that never touches the console: it reads the
// platform's own deployment + component records through `ctx.platform`. It is
// byte-identical across all 24 configuration types in this app, so the contract
// that drives it lives in `qradarContracts.ts`.

/** A SUCCEEDED deployment record, overridable field by field. */
export function deploymentSummary(over: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id: 'dep-1',
    canvasId: 'canvas-1',
    status: 'SUCCEEDED',
    healthScore: 100,
    startedAt: '2026-02-03T09:00:00.000Z',
    completedAt: '2026-02-03T09:05:00.000Z',
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
 * query the handler makes against it.
 */
export function statusContext(
  configTypeId: string,
  opts: {
    latest?: DeploymentSummary | null
    component?: ComponentRef | null
    version?: number
    /** Make `getLatestDeployment` reject, to exercise the handler's catch. */
    platformFails?: boolean
  } = {},
): StatusProbe {
  const deploymentQueries: StatusProbe['deploymentQueries'] = []
  const comp = opts.component === undefined ? component() : opts.component

  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, args) => {
      deploymentQueries.push({ canvasId, status: args?.status })
      if (opts.platformFails) throw new Error('platform data unavailable')
      return opts.latest ?? null
    },
    listComponents: async () => (comp ? [comp] : []),
  }

  const ctx = {
    appId: 'ibm-qradar',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 4 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: defaultSettings(),
    platform,
    component: comp,
    credential: CREDENTIAL,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries }
}
