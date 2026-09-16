// =============================================================================
// Fake Carbon Black Cloud vendor — the harness the deploy / rollback /
// healthCheck / driftDetect handler tests drive.
//
// Every Carbon Black handler reaches CBC through `lib/carbonblack.ts`, which
// uses global `fetch`. Replacing `globalThis.fetch` with a queue of canned
// responses therefore exercises a handler end to end — its request sequence,
// the bodies it sends, its error handling and the rollback state it records —
// with no module mocking and no new dependency.
//
// CBC authenticates with a single static header, `X-Auth-Token: <secret>/<id>`
// (there is no OAuth exchange), so the FIRST recorded call is already a real
// API request and must carry that header. The secret is half of that header and
// must never reach a result message — `mentionsSecret` is what the tests assert
// that with.
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  CredentialRef,
  DeployContext,
  DeploymentSummary,
  DriftContext,
  HealthCheckContext,
  PlatformDataApi,
  PipelineContext,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

export const BASE_URL = 'https://defense.conferdeploy.net'
export const ORG_KEY = 'ABCD1234'
export const API_ID = 'CBAPIID01'
/** The API Secret Key. Nothing a handler returns to the operator may contain it. */
export const API_SECRET = 'cb-secret-key-must-not-leak'
/** X-Auth-Token is the secret FIRST, then the id. */
export const AUTH_TOKEN = `${API_SECRET}/${API_ID}`

/** The app settings a working connection has: region host + org key. */
export const CB_SETTINGS: Record<string, unknown> = { base_url: BASE_URL, org_key: ORG_KEY }
/** A credential that is present but unusable because the Org Key setting is blank. */
export const NO_ORG_KEY_SETTINGS: Record<string, unknown> = { base_url: BASE_URL, org_key: '' }
/** A credential that is present but unusable because the region base URL is blank. */
export const NO_BASE_URL_SETTINGS: Record<string, unknown> = { base_url: '', org_key: ORG_KEY }

// --- Recorded calls ----------------------------------------------------------

export interface RecordedCall {
  url: string
  /** The request path with the region origin and any query string removed. */
  path: string
  method: string
  /** The X-Auth-Token header value. */
  authToken: string
  body: string
  /** The request body parsed as JSON (null when there was none or it was unparseable). */
  json: unknown
}

export interface CannedResponse {
  status?: number
  body?: unknown
}

/** A 2xx JSON response. */
export function cbJson(body: unknown, status = 200): CannedResponse {
  return { status, body }
}

/** A CBC failure — a non-2xx carrying the `message` field `cbErrorMessage` reads. */
export function cbError(message: string, status = 400): CannedResponse {
  return { status, body: { message, error_code: 'REQUEST_FAILED' } }
}

/** A 404 — the status several handlers treat as "already gone", not a failure. */
export function cbNotFound(): CannedResponse {
  return { status: 404, body: { message: 'not found' } }
}

/** One page of a CBC `_search` collection (the start/rows model `searchAllAt` pages). */
export function searchPage(results: unknown[], numFound?: number): CannedResponse {
  return { status: 200, body: { num_found: numFound ?? results.length, results } }
}

/** An empty `_search` collection — what a search returns when nothing exists yet. */
export const EMPTY_SEARCH: CannedResponse = searchPage([])
/** An empty `{ results: [] }` collection — what a plain GET list returns when empty. */
export const EMPTY_LIST: CannedResponse = cbJson({ results: [] })

function parseBody(body: string): unknown {
  if (!body) return null
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

/** Strip the region origin and the query string, leaving the API path. */
function apiPath(url: string): string {
  const noQuery = url.split('?')[0]
  return noQuery.startsWith(BASE_URL) ? noQuery.slice(BASE_URL.length) : noQuery
}

interface FetchInit {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Run `body` with `globalThis.fetch` replaced by a queue of canned responses,
 * handing it every recorded call. The queue is consumed in order; once it is
 * exhausted every further call sees an empty 200 so an unexpected extra request
 * shows up as a failed assertion rather than a hang. Fetch is always restored,
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
    calls.push({
      url,
      path: apiPath(url),
      method: init?.method ?? 'GET',
      authToken: init?.headers?.['X-Auth-Token'] ?? '',
      body: requestBody,
      json: parseBody(requestBody),
    })
    const next = queue.shift() ?? cbJson({})
    const status = next.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (): string | null => null },
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

// --- Call assertions ---------------------------------------------------------

/** Every recorded call to one API path (query string ignored). */
export function callsTo(calls: RecordedCall[], path: string): RecordedCall[] {
  return calls.filter((call) => call.path === path)
}

/** Every call that changes state — anything but a GET, minus the read-only `_search` POSTs. */
export function writes(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET' && !call.path.endsWith('/_search'))
}

/** A recorded request body as a JSON object. */
export function objectBody(call: RecordedCall | undefined): Record<string, unknown> {
  const json = call?.json
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
}

/** A recorded request body as a JSON array (the `_bulk` and rule-config shapes). */
export function arrayBody(call: RecordedCall | undefined): unknown[] {
  return Array.isArray(call?.json) ? (call!.json as unknown[]) : []
}

/**
 * Whether a handler's operator-facing text carries the API secret. Every handler
 * result and error message must answer false — the secret is half the auth
 * header and a leak puts it in deployment logs.
 */
export function mentionsSecret(text: unknown): boolean {
  return String(text ?? '').includes(API_SECRET)
}

// --- Context fixtures --------------------------------------------------------

export function credential(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'Carbon Black API key',
    username: API_ID,
    password: API_SECRET,
    apiToken: null,
    certificate: null,
    ...overrides,
  } as CredentialRef
}

export interface ItemInput {
  id?: string
  name: string
  fields: Record<string, unknown>
}

export interface FixtureOptions {
  configTypeId?: string
  items?: ItemInput[]
  settings?: Record<string, unknown>
  /** `null` means no credential is configured; omit for the default API key. */
  credential?: CredentialRef | null
  /** Rollback entries the platform hands back as the previous SUCCEEDED deployment. */
  priorEntries?: unknown[]
  /** Make `getLatestDeployment` reject, to exercise the "no prior state" path. */
  platformThrows?: boolean
  /**
   * Override the previous SUCCEEDED deployment's timestamps. `null` forces
   * "never deployed"; a deployment still in flight has a `startedAt` but a
   * null `completedAt`.
   */
  latestDeployment?: { startedAt?: string; completedAt?: string | null } | null
  /** Drop `ctx.component`, as a canvas not yet assigned to one has. */
  noComponent?: boolean
}

export const STARTED_AT = '2026-01-01T00:00:00.000Z'
export const COMPLETED_AT = '2026-01-01T00:01:00.000Z'

export function makeCanvas(items: ItemInput[] = [], configTypeId = 'cb'): CanvasSnapshot {
  const snapshotItems: CanvasItemSnapshot[] = items.map((item, index) => ({
    id: item.id ?? `item-${index + 1}`,
    name: item.name,
    fields: item.fields,
  })) as CanvasItemSnapshot[]
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'carbon-black',
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
      if (opts.latestDeployment === null) return null
      if (!opts.priorEntries && opts.latestDeployment === undefined) return null
      return {
        id: 'dep-1',
        canvasId: 'canvas-1',
        status: 'SUCCEEDED',
        healthScore: 100,
        startedAt: opts.latestDeployment?.startedAt ?? STARTED_AT,
        completedAt:
          opts.latestDeployment && 'completedAt' in opts.latestDeployment
            ? opts.latestDeployment.completedAt
            : COMPLETED_AT,
        environment: { id: 'env-1', name: 'production' },
        rollbackData: { entries: opts.priorEntries ?? [] },
      } as unknown as DeploymentSummary
    },
    listComponents: async () => [],
  } as PlatformDataApi
}

function baseContext(opts: FixtureOptions): Record<string, unknown> & { canvas: CanvasSnapshot } {
  const configTypeId = opts.configTypeId ?? 'cb'
  const canvas = makeCanvas(opts.items ?? [], configTypeId)
  return {
    appId: 'carbon-black',
    customerId: 'cust-1',
    configTypeId,
    canvas,
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: opts.settings ?? CB_SETTINGS,
    platform: platformStub(opts),
    component: opts.noComponent
      ? undefined
      : {
          id: 'comp-1',
          hostname: 'defense.conferdeploy.net',
          port: '443',
          type: ['carbon-black-cloud'],
          toolId: 'carbon-black',
        },
    credential: opts.credential === undefined ? credential() : opts.credential,
    connectivity: null,
    connectivityProvider: null,
  }
}

export function deployContext(opts: FixtureOptions = {}): DeployContext {
  return { ...baseContext(opts), previousConfig: null, strategy: 'DIRECT' } as unknown as DeployContext
}

export function rollbackContext(entries: unknown, opts: FixtureOptions = {}): RollbackContext {
  const base = baseContext(opts)
  return { ...base, rollbackData: entries, targetVersion: base.canvas } as unknown as RollbackContext
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
