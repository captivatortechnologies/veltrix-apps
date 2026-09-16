// =============================================================================
// Fake PVWA — the shared vendor stub every CyberArk handler test drives.
//
// `validate` was the only handler with tests; the five that actually touch a
// customer's vault (deploy, rollback, healthCheck, driftDetect, getStatus) had
// none. These apps reach PVWA through global `fetch`, so replacing
// `globalThis.fetch` with a queue of canned responses exercises a handler end to
// end — its request sequence, its bodies, its auth header, its error handling
// and the rollback state it records — with no module mocking and no new
// dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import. Every helper here is deliberately small: a test
// that has to fight its fixtures stops being evidence about the handler.
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
  /** The raw session header PVWA expects — NO "Bearer" prefix — or null. */
  authorization: string | null
  contentType: string | null
}

/** One canned PVWA response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
}

export interface FakePvwa {
  calls: RecordedCall[]
  restore: () => void
}

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 * Responses are consumed in order; a request past the end of the queue gets an
 * empty Gen2 collection so a trailing best-effort Logoff never needs fixturing.
 */
export function recordFetch(responses: CannedResponse[]): FakePvwa {
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
    })
    const next = queue.shift() ?? { status: 200, body: { value: [], count: 0 } }
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

// --- Canned responses ---------------------------------------------------------

/**
 * The session token the fake Logon hands out. Distinctive on purpose: a result
 * message or artifact carrying this string has leaked the vault session.
 */
export const LOGON_TOKEN = 'pvwa-session-token-MUST-NOT-LEAK'

/** The PVWA Logon response — a BARE JSON STRING holding the session token. */
export const LOGON: CannedResponse = { status: 200, body: JSON.stringify(LOGON_TOKEN) }

/** A Gen2 collection envelope: `{ value, count }`. */
export function collection(items: unknown[]): CannedResponse {
  return { status: 200, body: { value: items, count: items.length } }
}

/** A named-key envelope: `{ Platforms: [...], Total: n }` and friends. */
export function named(key: string, items: unknown[]): CannedResponse {
  return { status: 200, body: { [key]: items, Total: items.length } }
}

/** A PVWA error body (`{ErrorCode, ErrorMessage}`) at the given status. */
export function pvwaError(status: number, message: string, code = 'CAWS00001E'): CannedResponse {
  return { status, body: { ErrorCode: code, ErrorMessage: message } }
}

/** A plain 2xx acknowledgement with an optional body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A 2xx creation response carrying the created object. */
export function created(body: unknown = {}): CannedResponse {
  return { status: 201, body }
}

// --- Call predicates ----------------------------------------------------------

const LOGON_RE = /\/PasswordVault\/API\/auth\/[^/]+\/Logon$/
const LOGOFF_RE = /\/PasswordVault\/API\/auth\/Logoff$/

export function isLogon(call: RecordedCall): boolean {
  return LOGON_RE.test(call.url)
}

export function isLogoff(call: RecordedCall): boolean {
  return LOGOFF_RE.test(call.url)
}

/** Every call that is not part of the session lifecycle — the real work. */
export function vendorCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isLogon(call) && !isLogoff(call))
}

/** Parse a recorded request body. Returns null for a body-less request. */
export function bodyOf(call: RecordedCall | undefined): unknown {
  if (!call || !call.body) return null
  try {
    return JSON.parse(call.body)
  } catch {
    return null
  }
}

/** True when the session token appears anywhere in the given value. */
export function leaksToken(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(LOGON_TOKEN)
}

// --- Fixture constants --------------------------------------------------------

export const PVWA_HOST = 'pvwa.example.com'
export const PVWA_URL = `https://${PVWA_HOST}/PasswordVault`
export const API_URL = `${PVWA_URL}/API`
export const LEGACY_URL = `${PVWA_URL}/WebServices/PIMServices.svc`

/** The manager account Veltrix's own deploys are recorded under. */
export const MANAGER_USERNAME = 'veltrix-svc'

const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'PVWA manager account',
  username: MANAGER_USERNAME,
  password: 'manager-password',
  apiToken: null,
  certificate: null,
}

const PLATFORM_API: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

/** Build a canvas snapshot from a list of items (one item = one resource). */
export function canvas(items: CanvasItemSnapshot[], entityType = 'cyberark'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'cyberark',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

/** Shorthand for one canvas item. */
export function item(name: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { name, fields }
}

/** Per-test overrides — everything else is a working connection to PVWA. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  hostname?: string
  settings?: Record<string, unknown>
}

function baseContext(over: ContextOverrides) {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: over.settings ?? {},
    platform: PLATFORM_API,
    component: {
      id: 'comp-1',
      hostname: over.hostname ?? PVWA_HOST,
      port: '443',
      type: ['cyberark-pvwa'],
      toolId: 'cyberark',
    },
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

export function healthContext(items: CanvasItemSnapshot[], over: ContextOverrides = {}): HealthCheckContext {
  return {
    ...baseContext(over),
    canvas: canvas(items),
  } as unknown as HealthCheckContext
}

export function driftContext(items: CanvasItemSnapshot[], over: ContextOverrides = {}): DriftContext {
  return {
    ...baseContext(over),
    canvas: canvas(items),
    deployedConfig: canvas(items),
  } as unknown as DriftContext
}

// --- getStatus ----------------------------------------------------------------
// getStatus is the one handler that never touches PVWA: it reads the platform's
// own deployment + component records through `ctx.platform`. These helpers stub
// that API and record what the handler asked it for.

/** The PVWA component a deployed canvas reports against. */
export const STATUS_COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: PVWA_HOST,
  port: '443',
  type: ['cyberark-pvwa'],
  toolId: 'cyberark',
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

export interface StatusProbe {
  ctx: PipelineContext
  /** Each `getLatestDeployment` call, in order. */
  deploymentQueries: Array<{ canvasId: string; status?: string }>
  /** Each `listComponents` call's type filter, in order. */
  componentQueries: Array<string[] | undefined>
}

/**
 * Build a PipelineContext whose platform API returns `latest` / `components`,
 * recording every query the handler makes against it.
 */
export function statusContext(
  configTypeId: string,
  opts: { latest: DeploymentSummary | null; components?: ComponentRef[]; version?: number },
): StatusProbe {
  const deploymentQueries: StatusProbe['deploymentQueries'] = []
  const componentQueries: StatusProbe['componentQueries'] = []

  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, args) => {
      deploymentQueries.push({ canvasId, status: args?.status })
      return opts.latest
    },
    listComponents: async (filter) => {
      componentQueries.push(filter?.types)
      return opts.components ?? []
    },
  }

  const ctx = {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 7 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries, componentQueries }
}
