// =============================================================================
// Fake Cortex XDR tenant — the harness the deploy / rollback / healthCheck /
// driftDetect / getStatus handler tests drive.
//
// Every Cortex XDR handler reaches the tenant through `lib/cortexXdrApi.ts`,
// which uses global `fetch`. Replacing `globalThis.fetch` with a queue of canned
// responses therefore exercises a handler end to end — its request sequence, the
// bodies it sends, its error handling and the rollback state it records — with no
// module mocking and no new dependency.
//
// Cortex XDR Standard-security auth is two static headers on every call:
//   x-xdr-auth-id: <API Key ID>
//   Authorization: <API Key>      (verbatim — NO "Bearer " prefix)
// There is no token exchange, so the FIRST recorded call is already a real API
// request and must carry both headers. The API Key is the whole secret: nothing
// a handler hands back to an operator — message, artifacts, rollbackData or a
// drift diff — may contain it. `mentionsApiKey` is what the tests assert with.
//
// Two API generations are in play. The RPC-style `/public_api/v1/...` endpoints
// wrap requests in `{ request_data }` and replies in `{ reply }` (`cortexReply`
// / `cortexError` below). The newer `/platform/.../v1/...` REST-verb endpoints
// send and receive a bare JSON body (`platformJson` / `platformError`).
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

/** The tenant API FQDN an operator registers as the connection endpoint. */
export const TENANT_HOST = 'api-acme.xdr.us.paloaltonetworks.com'
export const BASE_URL = `https://${TENANT_HOST}`
/** Every RPC-style endpoint hangs off this prefix; the platform REST ones do not. */
export const PUBLIC_API_PREFIX = '/public_api/v1'
/** The API Key ID — stored on the credential's `username`. Not a secret. */
export const API_KEY_ID = '1471'
/** The API Key itself — the entire secret. Nothing a handler returns may contain it. */
export const API_KEY = 'cortex-xdr-api-key-must-not-leak'

/** The health / endpoint-group list probe every healthCheck in this app uses. */
export const HEALTH_PATH = '/endpoints/get_endpoint_groups/'

// --- Recorded calls ----------------------------------------------------------

export interface RecordedCall {
  url: string
  /** The request path with the tenant origin removed (query string kept — Cortex uses none). */
  path: string
  /** `path` with the `/public_api/v1` prefix stripped, so it matches the endpoint constants. */
  apiPath: string
  method: string
  /** The `x-xdr-auth-id` header value ('' when absent). */
  authId: string
  /** The `Authorization` header value ('' when absent). */
  authorization: string
  body: string
  /** The request body parsed as JSON (null when there was none or it was unparseable). */
  json: unknown
}

export interface CannedResponse {
  status?: number
  body?: unknown
}

/** A `/public_api/v1` success: the payload wrapped in Cortex's `{ reply }` envelope. */
export function cortexReply(payload: unknown, status = 200): CannedResponse {
  return { status, body: { reply: payload } }
}

/** A `/public_api/v1` failure: a non-2xx carrying the `{ reply: { err_msg } }` Cortex documents. */
export function cortexError(message: string, status = 400, extra?: string): CannedResponse {
  return { status, body: { reply: { err_code: status, err_msg: message, err_extra: extra } } }
}

/** A bare-JSON success from a `/platform/.../v1` REST endpoint (no `{ reply }` envelope). */
export function platformJson(payload: unknown, status = 200): CannedResponse {
  return { status, body: payload }
}

/** A bare-JSON failure from a `/platform/.../v1` REST endpoint. */
export function platformError(message: string, status = 400): CannedResponse {
  return { status, body: { message } }
}

/** A 204 with no body — what a REST DELETE answers. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }

/** An empty `{ reply: [] }` list — what a read returns when nothing exists yet. */
export const EMPTY_REPLY: CannedResponse = cortexReply([])
/** An empty `{ data: [] }` list — the platform REST equivalent. */
export const EMPTY_DATA: CannedResponse = platformJson({ data: [] })

function parseBody(body: string): unknown {
  if (!body) return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

interface FetchInit {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Run `body` with `globalThis.fetch` replaced by a queue of canned responses,
 * handing it every recorded call. The queue is consumed in order; once it is
 * exhausted every further call sees an empty 200, so an unexpected extra request
 * surfaces as a failed assertion rather than a hang. Fetch is always restored,
 * so one test's stub can never leak into the next.
 */
export async function withFetch<T>(
  responses: CannedResponse[],
  body: (calls: RecordedCall[]) => Promise<T>,
): Promise<T> {
  const calls: RecordedCall[] = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (input: unknown, init?: FetchInit) => {
    const url = String(input)
    const requestBody = typeof init?.body === 'string' ? init.body : ''
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url
    calls.push({
      url,
      path,
      apiPath: path.startsWith(PUBLIC_API_PREFIX) ? path.slice(PUBLIC_API_PREFIX.length) : path,
      method: init?.method ?? 'GET',
      authId: init?.headers?.['x-xdr-auth-id'] ?? '',
      authorization: init?.headers?.Authorization ?? '',
      body: requestBody,
      json: parseBody(requestBody),
    })
    const next = queue.shift() ?? cortexReply({})
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (): string => 'application/json' },
      text: async (): Promise<string> =>
        typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}),
    }
  }) as unknown as typeof globalThis.fetch

  try {
    return await body(calls)
  } finally {
    globalThis.fetch = original
  }
}

/** A fetch that never completes — the "the tenant is unreachable" path. */
export async function withFailingFetch<T>(reason: string, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error(reason)
  }) as unknown as typeof globalThis.fetch
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

// --- Call assertions ---------------------------------------------------------

/** Every recorded call to one `/public_api/v1` endpoint path. */
export function callsTo(calls: RecordedCall[], apiPath: string): RecordedCall[] {
  return calls.filter((call) => call.apiPath === apiPath)
}

/** Every recorded call to one full platform REST path. */
export function callsToPath(calls: RecordedCall[], path: string): RecordedCall[] {
  return calls.filter((call) => call.path === path)
}

/** A recorded request body as a JSON object. */
export function objectBody(call: RecordedCall | undefined): Record<string, unknown> {
  const json = call?.json
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : {}
}

/** The `request_data` object of an RPC-style request body. */
export function requestData(call: RecordedCall | undefined): Record<string, unknown> {
  const data = objectBody(call).request_data
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {}
}

/** The `request_data` ARRAY of a bulk RPC-style request body (insert_jsons, /bioc/insert). */
export function requestArray(call: RecordedCall | undefined): Array<Record<string, unknown>> {
  const data = objectBody(call).request_data
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []
}

/**
 * Whether a handler's operator-facing output carries the API Key. Every result
 * message, artifact, rollbackData blob and drift diff must answer false — a leak
 * puts the tenant's whole API key into deployment logs.
 */
export function mentionsApiKey(value: unknown): boolean {
  if (value === undefined) return false
  try {
    return JSON.stringify(value)?.includes(API_KEY) ?? false
  } catch {
    return String(value).includes(API_KEY)
  }
}

// --- Context fixtures --------------------------------------------------------

export function credential(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'Cortex XDR API key',
    username: API_KEY_ID,
    password: '',
    apiToken: API_KEY,
    certificate: null,
    ...overrides,
  }
}

/** A credential row that exists but carries no key value — resolves to "no credential". */
export const EMPTY_SECRET_CREDENTIAL = credential({ apiToken: null, password: '' })
/** A credential row with no API Key ID — Cortex needs both halves. */
export const NO_KEY_ID_CREDENTIAL = credential({ username: '' })

export interface ItemInput {
  id?: string
  name?: string
  fields: Record<string, unknown>
}

export interface FixtureOptions {
  configTypeId?: string
  items?: ItemInput[]
  settings?: Record<string, unknown>
  /** `null` means no credential is configured; omit for the default API key. */
  credential?: CredentialRef | null
  /** Drop the connection endpoint, as a component registered without a tenant FQDN has. */
  noHostname?: boolean
  /** Drop `ctx.component` entirely, as a canvas not yet assigned to one has. */
  noComponent?: boolean
  /** Make `getLatestDeployment` reject, to exercise the "platform unavailable" path. */
  platformThrows?: boolean
  /**
   * Override the previous SUCCEEDED deployment. `null` forces "never deployed";
   * a deployment still in flight has a `startedAt` but a null `completedAt`.
   */
  latestDeployment?: { startedAt?: string; completedAt?: string | null; healthScore?: number | null } | null
  /** Components `listComponents` reports; defaults to the one tenant component. */
  components?: ComponentRef[]
}

export const STARTED_AT = '2026-02-01T00:00:00.000Z'
export const COMPLETED_AT = '2026-02-01T00:01:00.000Z'

export const TENANT_COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: TENANT_HOST,
  port: '443',
  type: ['cortex-xdr-tenant'],
  toolId: 'cortex-xdr',
}

export function makeCanvas(items: ItemInput[] = [], configTypeId = 'cortex'): CanvasSnapshot {
  const snapshotItems: CanvasItemSnapshot[] = items.map((item, index) => ({
    id: item.id ?? `item-${index + 1}`,
    name: item.name ?? String(item.fields.name ?? `item-${index + 1}`),
    fields: item.fields,
  })) as CanvasItemSnapshot[]
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'cortex-xdr',
    entityType: configTypeId,
    items: snapshotItems,
    sections: snapshotItems,
    snapshot: {},
  } as unknown as CanvasSnapshot
}

function platformStub(opts: FixtureOptions): PlatformDataApi {
  return {
    getLatestDeployment: async (): Promise<DeploymentSummary | null> => {
      if (opts.platformThrows) throw new Error('platform unavailable')
      if (opts.latestDeployment === null || opts.latestDeployment === undefined) return null
      return {
        id: 'dep-1',
        canvasId: 'canvas-1',
        status: 'SUCCEEDED',
        healthScore:
          'healthScore' in opts.latestDeployment ? opts.latestDeployment.healthScore ?? null : 100,
        startedAt: opts.latestDeployment.startedAt ?? STARTED_AT,
        completedAt:
          'completedAt' in opts.latestDeployment ? opts.latestDeployment.completedAt ?? null : COMPLETED_AT,
        environment: { id: 'env-1', name: 'production' },
      } as unknown as DeploymentSummary
    },
    listComponents: async (): Promise<ComponentRef[]> => opts.components ?? [TENANT_COMPONENT],
  }
}

function baseContext(opts: FixtureOptions): Record<string, unknown> & { canvas: CanvasSnapshot } {
  const configTypeId = opts.configTypeId ?? 'cortex'
  const canvas = makeCanvas(opts.items ?? [], configTypeId)
  return {
    appId: 'cortex-xdr',
    customerId: 'cust-1',
    configTypeId,
    canvas,
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: opts.settings ?? {},
    platform: platformStub(opts),
    component: opts.noComponent
      ? undefined
      : { ...TENANT_COMPONENT, hostname: opts.noHostname ? '' : TENANT_HOST },
    credential: opts.credential === undefined ? credential() : opts.credential,
    connectivity: null,
    connectivityProvider: null,
  }
}

export function deployContext(opts: FixtureOptions = {}): DeployContext {
  return { ...baseContext(opts), previousConfig: null, strategy: 'DIRECT' } as unknown as DeployContext
}

export function rollbackContext(rollbackData: unknown, opts: FixtureOptions = {}): RollbackContext {
  const base = baseContext(opts)
  return { ...base, rollbackData, targetVersion: base.canvas } as unknown as RollbackContext
}

export function healthContext(opts: FixtureOptions = {}): HealthCheckContext {
  return baseContext(opts) as unknown as HealthCheckContext
}

export function driftContext(opts: FixtureOptions = {}): DriftContext {
  const base = baseContext(opts)
  return { ...base, deployedConfig: base.canvas } as unknown as DriftContext
}

export function pipelineContext(opts: FixtureOptions = {}): PipelineContext {
  return baseContext(opts) as unknown as PipelineContext
}
