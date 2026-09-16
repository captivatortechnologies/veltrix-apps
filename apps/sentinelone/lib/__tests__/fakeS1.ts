// =============================================================================
// Fake SentinelOne vendor — the harness the deploy/rollback/healthCheck/
// driftDetect handler tests drive.
//
// Every SentinelOne handler reaches the console through `lib/s1.ts`, which uses
// global `fetch`. Replacing `globalThis.fetch` with a queue of canned responses
// therefore exercises a handler end to end — its request sequence, the bodies it
// sends, its error handling and the rollback state it records — with no module
// mocking and no new dependency.
//
// SentinelOne authenticates with a static `Authorization: ApiToken <token>`
// header (there is no OAuth exchange), so the FIRST recorded call is already a
// real API request and must carry that header.
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  CredentialRef,
  DeployContext,
  DriftContext,
  HealthCheckContext,
  PlatformDataApi,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

export const CONSOLE_HOST = 'acme.sentinelone.net'
export const CONSOLE_URL = `https://${CONSOLE_HOST}`
export const API_BASE = `${CONSOLE_URL}/web/api/v2.1`
export const API_TOKEN = 's1-api-token'
/** The connection's service user — the identity drift attribution must exclude. */
export const SERVICE_USER = 'veltrix-svc'

// --- Recorded calls -----------------------------------------------------------

export interface RecordedCall {
  url: string
  /** The API path with the `/web/api/v<version>` prefix and query string removed. */
  path: string
  method: string
  authorization: string
  body: string
  /** The request body parsed as JSON ({} when there was none). */
  json: Record<string, unknown>
}

export interface CannedResponse {
  status?: number
  body?: unknown
}

/** A SentinelOne success envelope: { data, pagination }. */
export function envelope(data: unknown, nextCursor: string | null = null): CannedResponse {
  return {
    status: 200,
    body: {
      data,
      pagination: { nextCursor, totalItems: Array.isArray(data) ? data.length : 1 },
    },
  }
}

/** A SentinelOne failure envelope: a non-2xx status carrying `errors[]`. */
export function apiError(detail: string, status = 400): CannedResponse {
  return { status, body: { errors: [{ code: 4000000, type: 'request', title: 'Request failed', detail }] } }
}

/** An empty scoped collection — what a list returns when nothing exists yet. */
export const EMPTY_LIST: CannedResponse = envelope([])

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {}
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Strip the console origin, the `/web/api/v<version>` prefix and the query string. */
function apiPath(url: string): string {
  const noQuery = url.split('?')[0]
  const marker = '/web/api/'
  const at = noQuery.indexOf(marker)
  if (at < 0) return noQuery
  const rest = noQuery.slice(at + marker.length)
  const slash = rest.indexOf('/')
  return slash < 0 ? '' : rest.slice(slash)
}

interface FetchInit {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Run `body` with `globalThis.fetch` replaced by a queue of canned responses,
 * handing it every recorded call. The queue is consumed in order; once it is
 * exhausted every further call sees an empty collection. Fetch is always
 * restored, so one test's stub can never leak into the next.
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
      authorization: init?.headers?.Authorization ?? '',
      body: requestBody,
      json: parseBody(requestBody),
    })
    const next = queue.shift() ?? EMPTY_LIST
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

/** Every recorded call to one API path (query string ignored). */
export function callsTo(calls: RecordedCall[], path: string): RecordedCall[] {
  return calls.filter((call) => call.path === path)
}

/** The `data` object of a recorded request body. */
export function dataOf(call: RecordedCall | undefined): Record<string, unknown> {
  const data = call?.json.data
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
}

/** The `filter` object of a recorded request body — the scope a write is applied at. */
export function filterOf(call: RecordedCall | undefined): Record<string, unknown> {
  const filter = call?.json.filter
  return filter && typeof filter === 'object' ? (filter as Record<string, unknown>) : {}
}

// --- Context fixtures ---------------------------------------------------------

/** Scope settings used by every collection that is account-scoped in these tests. */
export const ACCOUNT_SETTINGS: Record<string, unknown> = { scope: 'account', scope_id: 'act-1' }
/** Scope settings for the site-scoped collections (groups). */
export const SITE_SETTINGS: Record<string, unknown> = { scope: 'site', scope_id: 'site-1' }
/** A configured scope with no id — the "Scope ID setting was never filled in" case. */
export const SCOPELESS_SETTINGS: Record<string, unknown> = { scope: 'account', scope_id: '' }

export function credential(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'SentinelOne API token',
    username: SERVICE_USER,
    password: '',
    apiToken: API_TOKEN,
    certificate: null,
    ...overrides,
  }
}

export interface CanvasItemInput {
  name: string
  fields: Record<string, unknown>
}

export interface FixtureOptions {
  configTypeId?: string
  sections?: CanvasItemInput[]
  settings?: Record<string, unknown>
  /** `null` means no credential is configured; omit for the default token. */
  credential?: CredentialRef | null
  hostname?: string
}

export function makeCanvas(sections: CanvasItemInput[] = [], configTypeId = 's1'): CanvasSnapshot {
  const items: CanvasItemSnapshot[] = sections.map((section, index) => ({
    id: `item-${index + 1}`,
    name: section.name,
    fields: section.fields,
  }))
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'sentinelone',
    entityType: configTypeId,
    items,
    sections: items,
    snapshot: {},
  }
}

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function baseContext(opts: FixtureOptions): Record<string, unknown> & { canvas: CanvasSnapshot } {
  const configTypeId = opts.configTypeId ?? 's1'
  const canvas = makeCanvas(opts.sections ?? [], configTypeId)
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId,
    canvas,
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: opts.settings ?? ACCOUNT_SETTINGS,
    platform: stubPlatform,
    component: {
      id: 'comp-1',
      hostname: opts.hostname ?? CONSOLE_HOST,
      port: '443',
      type: ['sentinelone-console'],
      toolId: 'sentinelone',
    },
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
