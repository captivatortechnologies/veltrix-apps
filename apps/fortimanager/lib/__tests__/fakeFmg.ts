// =============================================================================
// Fake FortiManager — the shared vendor stub every FortiManager handler test drives.
//
// `validate` was the only handler with tests in this app; the five that reach a
// customer's FortiManager and change its ADOM object database (deploy, rollback,
// healthCheck, driftDetect) or report on it (getStatus) had none.
//
// Every handler here reaches FortiManager through `lib/fortimanager.ts`, which
// uses global `fetch`, so replacing `globalThis.fetch` with a queue of canned
// responses drives a handler end to end — its login, its request sequence, its
// bodies, its error handling and the rollback state it records — with no module
// mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// What FortiManager makes different, and what the recorder therefore parses:
//
//   * It is JSON-RPC, not REST. Every call is `POST https://<host>/jsonrpc` and
//     the resource lives in the BODY — `method` ("get" / "set" / "add" /
//     "delete" / "exec") plus `params[0].url` (the ADOM object path). Asserting
//     "a POST happened" would say nothing, so every recorded call is parsed into
//     its RPC method, its target url, its data and its filter.
//
//   * Failure arrives inside a 200. `result[0].status.code` is the real outcome
//     (0 = OK); the HTTP status is almost always 200 even when the write was
//     refused. A handler that trusts `res.ok` from fetch reports a rejected
//     deploy as a success, so {@link rpcError} builds a 200 carrying a non-zero
//     code and the suites assert it is treated as a failure.
//
//   * Auth is a session, not a header. `exec sys/login/user` returns a `session`
//     that every later call carries in the body; `exec sys/logout` ends it.
//     Neither the admin password nor that session id may appear in a result
//     message, an artifact, rollbackData or a drift diff — both constants below
//     are distinctive so {@link leaksSecret} can prove it.
//
//   * A workspace-mode ADOM wraps writes in lock / commit / unlock. A deploy
//     that takes the lock and then fails must still release it, or the ADOM
//     stays locked against every other administrator.
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

// --- Identity of the fake FortiManager ----------------------------------------

export const HOST = 'fmg.example.com'
export const BASE_URL = `https://${HOST}`
export const ENDPOINT = `${BASE_URL}/jsonrpc`
export const ADOM = 'root'

export const ADMIN_USER = 'veltrix-svc'

/**
 * The FortiManager admin password. Distinctive on purpose: a result message,
 * artifact, rollbackData or diff carrying this string has leaked the customer's
 * FortiManager administrator credential.
 */
export const ADMIN_PASSWORD = 'fmg-admin-password-MUST-NOT-LEAK'

/**
 * The session id the fake login hands out. Equally must never surface — it is a
 * bearer credential for the whole ADOM until it expires.
 */
export const SESSION = 'fmg-session-token-MUST-NOT-LEAK'

// --- The fake transport -------------------------------------------------------

/** One outbound JSON-RPC call the handler made, as the fake saw it. */
export interface RpcCall {
  /** The HTTP endpoint — always `<base>/jsonrpc`. */
  url: string
  /** The HTTP verb — always POST. */
  method: string
  /** The JSON-RPC method: get | set | add | delete | exec. */
  rpcMethod: string
  /** `params[0].url` — the ADOM object path this call targets. */
  rpcUrl: string
  /** `params[0].data` — the object body on a write. */
  data: unknown
  /** `params[0].filter` — the mkey selector on a delete. */
  filter: unknown
  /** `params[0].option` — "force" on a delete. */
  option: unknown
  /** The session id carried on the call; null on the login itself. */
  session: string | null
  /** The raw serialised body, for the rare assertion that wants it verbatim. */
  body: string
}

/** One canned FortiManager response, consumed in order. */
export interface CannedResponse {
  /** HTTP status. FortiManager answers 200 even for logical failures. */
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
}

export interface FakeFmg {
  calls: RpcCall[]
  restore: () => void
}

function parseCall(url: string, method: string, rawBody: unknown): RpcCall {
  const body = typeof rawBody === 'string' ? rawBody : ''
  let rpcMethod = ''
  let rpcUrl = ''
  let data: unknown
  let filter: unknown
  let option: unknown
  let session: string | null = null
  try {
    const parsed = JSON.parse(body) as {
      method?: string
      session?: string | null
      params?: Array<{ url?: string; data?: unknown; filter?: unknown; option?: unknown }>
    }
    rpcMethod = parsed.method ?? ''
    session = parsed.session ?? null
    const param = parsed.params?.[0] ?? {}
    rpcUrl = param.url ?? ''
    data = param.data
    filter = param.filter
    option = param.option
  } catch {
    // A body that is not JSON is itself worth seeing in a failure message.
  }
  return { url, method, rpcMethod, rpcUrl, data, filter, option, session, body }
}

/** The response a queue that has run out answers with: a bare, successful ack. */
const EXHAUSTED: CannedResponse = { status: 200, body: { result: [{ status: { code: 0, message: 'OK' } }] } }

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 *
 * The first response a handler consumes is ALWAYS the login: `FmgClient` calls
 * `ensureSession()` before its first real request and caches the session per
 * client instance, and a handler builds one client per invocation.
 *
 * A call past the end of the queue gets a bare OK, so the trailing `sys/logout`
 * never needs fixturing. Every suite still asserts the exact call sequence, so
 * that default cannot silently absorb a call the handler should not have made.
 */
export function recordFmg(responses: CannedResponse[]): FakeFmg {
  const calls: RpcCall[] = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push(parseCall(String(input), init?.method ?? 'GET', init?.body))
    const next = queue.shift() ?? EXHAUSTED
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
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

/**
 * A FortiManager that cannot be reached at all — every fetch rejects, the way a
 * DNS failure, a refused connection or an aborted timeout surfaces. The client
 * turns that into a `transportError`; a handler must return a failed RESULT,
 * not throw, or the pipeline reports an opaque crash instead of a message.
 */
export function recordUnreachableFmg(reason = 'ECONNREFUSED 10.9.9.9:443'): FakeFmg {
  const calls: RpcCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    calls.push(parseCall(String(input), init?.method ?? 'GET', init?.body))
    throw new Error(reason)
  }) as unknown as typeof globalThis.fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** Run `fn` against a canned FortiManager, always restoring global fetch. */
export async function withFmg(
  responses: CannedResponse[],
  fn: (calls: RpcCall[]) => Promise<void>,
): Promise<void> {
  const fake = recordFmg(responses)
  try {
    await fn(fake.calls)
  } finally {
    fake.restore()
  }
}

/** Run `fn` against a FortiManager that cannot be reached. */
export async function withUnreachableFmg(fn: (calls: RpcCall[]) => Promise<void>, reason?: string): Promise<void> {
  const fake = recordUnreachableFmg(reason)
  try {
    await fn(fake.calls)
  } finally {
    fake.restore()
  }
}

// --- Canned JSON-RPC responses ------------------------------------------------

/** A successful login, carrying the session every later call must present. */
export const LOGIN_OK: CannedResponse = {
  status: 200,
  body: { id: 1, session: SESSION, result: [{ status: { code: 0, message: 'OK' }, url: 'sys/login/user' }] },
}

/**
 * A rejected login. FortiManager answers 200 with a non-zero code and, crucially,
 * NO session — so a handler that only looks at the HTTP status proceeds
 * unauthenticated.
 */
export function loginFailure(message = 'Login fail', code = -22): CannedResponse {
  return { status: 200, body: { id: 1, result: [{ status: { code, message }, url: 'sys/login/user' }] } }
}

/** A successful call, optionally carrying `data` (a listing, or one object). */
export function rpcOk(data?: unknown): CannedResponse {
  return { status: 200, body: { id: 1, result: [{ status: { code: 0, message: 'OK' }, data }] } }
}

/**
 * A REFUSED call — HTTP 200 with a non-zero `status.code`, which is how every
 * real FortiManager failure arrives. Avoid code -11 unless you mean to exercise
 * the client's re-login-and-retry, which that code triggers.
 */
export function rpcError(message: string, code = -3): CannedResponse {
  return { status: 200, body: { id: 1, result: [{ status: { code, message } }] } }
}

/** An HTTP-level failure (a proxy 502, a WAF 403) with no JSON-RPC envelope. */
export function httpError(status: number, body: unknown = ''): CannedResponse {
  return { status, body }
}

/** The successful `exec sys/logout` acknowledgement. */
export const LOGOUT_OK: CannedResponse = rpcOk()

// --- Call predicates ----------------------------------------------------------

export function isLogin(call: RpcCall): boolean {
  return call.rpcUrl === 'sys/login/user'
}

export function isLogout(call: RpcCall): boolean {
  return call.rpcUrl === 'sys/logout'
}

export function isWorkspace(call: RpcCall): boolean {
  return call.rpcUrl.includes('/workspace/')
}

/** Everything that is not session management — the real work against the ADOM. */
export function objectCalls(calls: RpcCall[]): RpcCall[] {
  return calls.filter((call) => !isLogin(call) && !isLogout(call))
}

/**
 * Calls that CHANGE the ADOM object database. A read-only handler must make
 * none. Workspace lock/commit/unlock are excluded — they are transaction
 * management, not a write to a customer's objects.
 */
export function mutatingCalls(calls: RpcCall[]): RpcCall[] {
  return objectCalls(calls).filter((call) => call.rpcMethod !== 'get' && !isWorkspace(call))
}

/** The workspace transaction calls, in the order they were made. */
export function workspaceCalls(calls: RpcCall[]): RpcCall[] {
  return calls.filter(isWorkspace)
}

/** True when the admin password or the session id appears anywhere in `value`. */
export function leaksSecret(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(ADMIN_PASSWORD) || json.includes(SESSION)
}

interface Asserter {
  ok: (v: unknown, m?: string) => void
  equal: (a: unknown, b: unknown, m?: string) => void
  deepEqual: (a: unknown, b: unknown, m?: string) => void
}

/**
 * Assert the handler logged in before touching the ADOM and that every later
 * call carried the session. Returns the non-session calls so a test can go on
 * asserting them.
 */
export function assertLoggedInFirst(assert: Asserter, calls: RpcCall[]): RpcCall[] {
  assert.ok(calls.length > 0, 'handler made no call at all')
  assert.ok(isLogin(calls[0]), `first call must be the login, was ${calls[0].rpcMethod} ${calls[0].rpcUrl}`)
  assert.equal(calls[0].method, 'POST', 'JSON-RPC is always a POST')
  assert.equal(calls[0].url, ENDPOINT, 'the login goes to the /jsonrpc endpoint')
  assert.equal(calls[0].session, null, 'the login itself carries no session')
  assert.deepEqual(calls[0].data, [{ user: ADMIN_USER, passwd: ADMIN_PASSWORD }], 'login sends the admin credential')
  for (const call of objectCalls(calls)) {
    assert.equal(call.session, SESSION, `call without the session: ${call.rpcMethod} ${call.rpcUrl}`)
  }
  return objectCalls(calls)
}

/** Assert the handler ended its session rather than leaking it server-side. */
export function assertLoggedOut(assert: Asserter, calls: RpcCall[]): void {
  assert.ok(calls.some(isLogout), 'handler never called sys/logout — the session stays open on the FortiManager')
}

// --- Canvas + context ---------------------------------------------------------

/** Shorthand for one canvas item. */
export function item(name: string, fields: Record<string, unknown> = {}, id?: string): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'fortimanager'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 4,
    name: 'Test Canvas',
    toolType: 'fortimanager',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

export const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'FortiManager admin',
  username: ADMIN_USER,
  password: ADMIN_PASSWORD,
  apiToken: null,
  certificate: null,
}

/** A credential with no password — configured, but unusable. */
export const CREDENTIAL_WITHOUT_PASSWORD: CredentialRef = { ...CREDENTIAL, password: '' }

export const COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: HOST,
  port: '443',
  type: ['fortimanager'],
  toolId: 'fortimanager',
}

/** Per-test overrides — everything else is a working connection to FortiManager. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Replaces the default settings entirely; `{}` models a missing Host. */
  settings?: Record<string, unknown>
  /** Turn on the ADOM workspace lock / commit / unlock transaction. */
  workspaceMode?: boolean
  /** Deploy to a non-default ADOM, to prove the object path is scoped by it. */
  adom?: string
  /** The rollbackData the previous SUCCEEDED deployment recorded, if any. */
  priorRollbackData?: unknown
  /** Canvas items for `deployedConfig`, when drift should see a different desired state. */
  deployedItems?: CanvasItemSnapshot[]
  component?: ComponentRef | null
}

export function settingsFor(over: ContextOverrides): Record<string, unknown> {
  if (over.settings) return over.settings
  const settings: Record<string, unknown> = { host: HOST, adom: over.adom ?? ADOM }
  if (over.workspaceMode) settings.workspace_mode = true
  return settings
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

function baseContext(over: ContextOverrides) {
  return {
    appId: 'fortimanager',
    customerId: 'cust-1',
    configTypeId: 'fortimanager',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: settingsFor(over),
    platform: platformApi(over),
    component: over.component === undefined ? COMPONENT : over.component,
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
// getStatus is the one handler that never touches FortiManager: it reads the
// platform's own deployment record through `ctx.platform`. It is code-identical
// across all 32 configuration types, so its contract is shared.

export const STARTED_AT = '2026-01-01T10:00:00.000Z'
export const COMPLETED_AT = '2026-01-01T10:05:00.000Z'

/** A SUCCEEDED deployment record, overridable field by field. */
export function deploymentSummary(over: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id: 'dep-1',
    canvasId: 'canvas-1',
    status: 'SUCCEEDED',
    healthScore: 95,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
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
    appId: 'fortimanager',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 4 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { host: HOST, adom: ADOM },
    platform,
    component: opts.component === undefined ? COMPONENT : opts.component,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries }
}
