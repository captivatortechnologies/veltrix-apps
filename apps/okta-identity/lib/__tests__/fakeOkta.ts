// =============================================================================
// Fake Okta org — the harness the deploy/rollback/healthCheck/driftDetect
// handler tests drive.
//
// Every okta-identity handler reaches the org through `lib/okta.ts`, which uses
// global `fetch`. Replacing `globalThis.fetch` with a queue of canned responses
// therefore exercises a handler end to end — its request sequence, the bodies it
// sends, its error handling and the rollback state it records — with no module
// mocking and no new dependency.
//
// Okta authenticates with a static `Authorization: SSWS <token>` header (there
// is no OAuth exchange), so the FIRST recorded call is already a real Management
// API request and must carry that header. Nothing may echo the token back out:
// this app manages IDENTITY, so a leaked SSWS token in a result message is a
// live admin credential in a deployment log.
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  ComponentRef,
  CredentialRef,
  DeploymentSummary,
  DeployContext,
  DriftContext,
  HealthCheckContext,
  PipelineContext,
  PlatformDataApi,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

/** The org domain a component points at. */
export const ORG_HOST = 'dev-12345.okta.com'
export const BASE_URL = `https://${ORG_HOST}`
/** Every Management API route lives under this prefix. */
export const API_BASE = `${BASE_URL}/api/v1`
/**
 * The SSWS token. Deliberately distinctive so a leak assertion is meaningful:
 * no result message, error or artifact may ever contain this string.
 */
export const API_TOKEN = 'ssws-SUPERSECRET-admin-token'
/** The connection's admin identity — the login drift attribution must exclude. */
export const ADMIN_LOGIN = 'veltrix-admin@example.com'

// --- Recorded calls -----------------------------------------------------------

export interface RecordedCall {
  url: string
  /** The API path with the origin and `/api/v1` prefix and query string removed. */
  path: string
  method: string
  /** The `Authorization` header exactly as sent. */
  authorization: string
  /** The raw request body ('' when there was none). */
  body: string
  /** The request body parsed as JSON ({} when there was none). */
  json: Record<string, unknown>
  /** The query string parsed into a plain record. */
  query: Record<string, string>
}

export interface CannedResponse {
  status?: number
  body?: unknown
  /** Extra response headers, e.g. a `link` header to drive pagination. */
  headers?: Record<string, string>
}

/** A 2xx JSON response. */
export function ok(body: unknown, status = 200): CannedResponse {
  return { status, body }
}

/** An empty collection — what a list returns when nothing exists yet. */
export const EMPTY_LIST: CannedResponse = { status: 200, body: [] }

/** Okta's "object does not exist" response. */
export function notFound(summary = 'Not found: Resource not found'): CannedResponse {
  return { status: 404, body: { errorCode: 'E0000007', errorSummary: summary } }
}

/**
 * An Okta API failure: a non-2xx status carrying the `errorSummary` /
 * `errorCauses` shape `oktaErrorMessage` reads.
 */
export function apiError(summary: string, status = 400, causes: string[] = []): CannedResponse {
  return {
    status,
    body: {
      errorCode: 'E0000001',
      errorSummary: summary,
      errorCauses: causes.map((errorSummary) => ({ errorSummary })),
    },
  }
}

/** Okta's response when the SSWS token is invalid or lacks the required admin role. */
export function unauthorized(): CannedResponse {
  return { status: 401, body: { errorCode: 'E0000011', errorSummary: 'Invalid token provided' } }
}

function parseBody(body: string): Record<string, unknown> {
  if (!body) return {}
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Strip the origin, the `/api/v1` prefix and the query string. */
function apiPath(url: string): string {
  const noQuery = url.split('?')[0]
  const marker = '/api/v1'
  const at = noQuery.indexOf(marker)
  return at < 0 ? noQuery : noQuery.slice(at + marker.length)
}

function parseQuery(url: string): Record<string, string> {
  const at = url.indexOf('?')
  if (at < 0) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(url.slice(at + 1))) out[key] = value
  return out
}

interface FetchInit {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Run `body` with `globalThis.fetch` replaced by a queue of canned responses,
 * handing it every recorded call. The queue is consumed in order; once it is
 * exhausted every further call sees an empty collection, so a test only has to
 * script the responses it actually asserts on. Fetch is always restored, so one
 * test's stub can never leak into the next.
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
      query: parseQuery(url),
    })

    const next = queue.shift() ?? EMPTY_LIST
    const status = next.status ?? 200
    const headers = new Map<string, string>()
    for (const [key, value] of Object.entries(next.headers ?? {})) {
      headers.set(key.toLowerCase(), value)
    }

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string): string | null => headers.get(name.toLowerCase()) ?? null },
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

// --- Call assertions ----------------------------------------------------------

/** Every recorded call whose path matches exactly (query string ignored). */
export function callsTo(calls: RecordedCall[], path: string): RecordedCall[] {
  return calls.filter((call) => call.path === path)
}

/** Every recorded call whose path contains `fragment`. */
export function callsMatching(calls: RecordedCall[], fragment: string | RegExp): RecordedCall[] {
  return calls.filter((call) =>
    fragment instanceof RegExp ? fragment.test(call.path) : call.path.includes(fragment),
  )
}

/** Every recorded call made with a given HTTP method. */
export function callsWithMethod(calls: RecordedCall[], method: string): RecordedCall[] {
  return calls.filter((call) => call.method === method)
}

/** The calls that WRITE — the ones that change a customer's identity estate. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.method !== 'GET')
}

/**
 * True when `value`, serialized, contains the SSWS token anywhere. Handler
 * results are logged and surfaced in the UI, so this must always be false.
 */
export function leaksToken(value: unknown): boolean {
  try {
    return JSON.stringify(value ?? null).includes(API_TOKEN)
  } catch {
    return String(value).includes(API_TOKEN)
  }
}

/** The `profile` object of a recorded request body. */
export function profileOf(call: RecordedCall | undefined): Record<string, unknown> {
  const profile = call?.json.profile
  return profile && typeof profile === 'object' ? (profile as Record<string, unknown>) : {}
}

// --- Context fixtures ---------------------------------------------------------

export function credential(overrides: Partial<CredentialRef> = {}): CredentialRef {
  return {
    id: 'cred-1',
    name: 'Okta API token',
    username: ADMIN_LOGIN,
    password: '',
    apiToken: API_TOKEN,
    certificate: null,
    ...overrides,
  }
}

/** A credential row that exists but carries no usable SSWS token. */
export function emptyCredential(): CredentialRef {
  return credential({ apiToken: '', password: '' })
}

export interface CanvasItemInput {
  name: string
  fields: Record<string, unknown>
  /** Override the generated stable item id (the rename-safe match key). */
  id?: string
}

export interface FixtureOptions {
  configTypeId?: string
  sections?: CanvasItemInput[]
  settings?: Record<string, unknown>
  /** `null` means no credential is configured; omit for the default token. */
  credential?: CredentialRef | null
  /** `''` means no org is registered on the component. */
  hostname?: string
  /** What `platform.getLatestDeployment` resolves to (default: null). */
  latestDeployment?: DeploymentSummary | null
  /** What `platform.listComponents` resolves to (default: the fixture component). */
  components?: ComponentRef[]
  /** Make `platform.getLatestDeployment` reject, to prove the handler tolerates it. */
  platformThrows?: boolean
}

export function makeCanvas(sections: CanvasItemInput[] = [], configTypeId = 'okta'): CanvasSnapshot {
  const items: CanvasItemSnapshot[] = sections.map((section, index) => ({
    id: section.id ?? `item-${index + 1}`,
    name: section.name,
    fields: section.fields,
  }))
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'okta-identity',
    entityType: configTypeId,
    items,
    // `sections` is the alias every okta-identity extractor reads.
    sections: items,
    snapshot: {},
  }
}

export const FIXTURE_COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: ORG_HOST,
  port: '443',
  type: ['okta-org'],
  toolId: 'okta-identity',
}

/** A SUCCEEDED deployment carrying a stored item-id -> okta-id map. */
export function priorDeployment(
  resourceIds: Record<string, string>,
  overrides: Partial<DeploymentSummary> = {},
): DeploymentSummary {
  return {
    id: 'dep-1',
    status: 'SUCCEEDED',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    healthScore: 100,
    rollbackData: { resourceIds },
    ...overrides,
  } as unknown as DeploymentSummary
}

function makePlatform(opts: FixtureOptions): PlatformDataApi {
  return {
    getLatestDeployment: async () => {
      if (opts.platformThrows) throw new Error('platform unavailable')
      return opts.latestDeployment ?? null
    },
    listComponents: async () => opts.components ?? [FIXTURE_COMPONENT],
  }
}

function baseContext(opts: FixtureOptions): Record<string, unknown> & { canvas: CanvasSnapshot } {
  const configTypeId = opts.configTypeId ?? 'okta'
  const canvas = makeCanvas(opts.sections ?? [], configTypeId)
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId,
    canvas,
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'author@example.com', name: 'Author' },
    settings: opts.settings ?? {},
    platform: makePlatform(opts),
    component: { ...FIXTURE_COMPONENT, hostname: opts.hostname ?? ORG_HOST },
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

/**
 * Drift compares the LAST DEPLOYED config against the live org, so the sections
 * go on `deployedConfig` and `canvas` is left EMPTY. A handler that read
 * `ctx.canvas` here would compare the org against the unsaved working canvas —
 * it would find nothing to check and report "no drift", the worst possible
 * failure for a drift detector. Keeping the two distinct is what makes that
 * visible instead of silently passing.
 */
export function driftContext(opts: FixtureOptions = {}): DriftContext {
  const base = baseContext(opts)
  const deployedConfig = base.canvas
  return {
    ...base,
    canvas: makeCanvas([], opts.configTypeId ?? 'okta'),
    deployedConfig,
  } as unknown as DriftContext
}

export function statusContext(opts: FixtureOptions = {}): PipelineContext {
  return baseContext(opts) as unknown as PipelineContext
}

// --- System Log fixtures ------------------------------------------------------

/** One System Log event, shaped as `resolveDriftActor` reads it. */
export function logEvent(opts: {
  login?: string
  displayName?: string
  eventType?: string
  published?: string
  type?: string
}): Record<string, unknown> {
  return {
    actor: {
      id: 'actor-1',
      type: opts.type ?? 'User',
      displayName: opts.displayName ?? 'Nina Admin',
      alternateId: opts.login ?? 'nina@example.com',
    },
    published: opts.published ?? '2026-02-02T10:00:00.000Z',
    eventType: opts.eventType ?? 'group.lifecycle.update',
  }
}
