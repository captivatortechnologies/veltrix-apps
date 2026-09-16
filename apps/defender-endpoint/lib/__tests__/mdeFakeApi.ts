// =============================================================================
// A fake Defender for Endpoint API for the handler tests.
//
// `validate` was the only handler under test in this app; the five that actually
// act on a customer's tenant (deploy, rollback, healthCheck, driftDetect,
// getStatus) were not. Every one of them reaches Microsoft through global
// `fetch`, so replacing `fetch` with a recorded fake drives a handler end to end
// — its Entra token exchange, its request sequence, its request bodies, its
// failure handling and the rollback state it records — with no module mocking
// and no new dependency.
//
// This module is test support, not app code: it lives under lib/__tests__/ and
// is imported by the per-config-type suites. It is not itself a `*.test.ts`
// file, so the runner bundles it but never executes it as a suite.
// =============================================================================

import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  ComponentRef,
  CredentialRef,
  DeployContext,
  DriftContext,
  HealthCheckContext,
  PipelineContext,
  PlatformDataApi,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

/** One recorded outbound request. `body` is parsed JSON when the body was JSON. */
export interface Call {
  method: string
  url: string
  body: unknown
}

/** Answers every non-token request: the fake tenant's state for one test. */
export type Responder = (method: string, url: string) => { status: number; body: unknown }

/** The Entra client-credentials path — recorded, but answered by the fake itself. */
export const TOKEN_PATH = '/oauth2/v2.0/token'

export const TENANT = '11111111-2222-3333-4444-555555555555'
export const API_HOST = 'api.security.microsoft.com'
export const GRAPH_HOST = 'graph.microsoft.com'
/** The Defender device id shape: 40 hex characters. */
export const MACHINE_ID = 'd'.repeat(40)

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

/**
 * Replace global fetch with a recorded fake Defender API. The token exchange is
 * answered automatically but still RECORDED, so a handler that reached the API
 * before authenticating shows up as a non-token first call.
 */
export function mockMdeFetch(responder: Responder): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ method, url: u, body: parseBody(init?.body) })
    const { status, body } = u.includes(TOKEN_PATH)
      ? { status: 200, body: { access_token: 'test-token', expires_in: 3600 } }
      : responder(method, u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return calls
}

/**
 * The same fake, but reporting the raw `init` of every call — needed where the
 * request is not JSON (the Live Response multipart upload) or where the ABSENCE
 * of a header is the thing under test.
 */
export function mockMdeFetchRaw(
  responder: Responder,
): Array<{ method: string; url: string; init: { method?: string; body?: unknown; headers?: Record<string, string> } }> {
  const calls: Array<{ method: string; url: string; init: { method?: string; body?: unknown; headers?: Record<string, string> } }> = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ method, url: u, init: init ?? {} })
    const { status, body } = u.includes(TOKEN_PATH)
      ? { status: 200, body: { access_token: 'test-token', expires_in: 3600 } }
      : responder(method, u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return calls
}

/** Every call except the token exchange — i.e. what the handler did to the tenant. */
export const vendorCalls = (calls: Call[]): Call[] => calls.filter((c) => !c.url.includes(TOKEN_PATH))

/** An MDE / Graph error body, as the real APIs shape it. */
export const apiError = (message: string): { error: { message: string } } => ({ error: { message } })

export const component: ComponentRef = {
  id: 'comp-1',
  hostname: API_HOST,
  port: '443',
  type: ['mde-tenant'],
  toolId: 'defender-endpoint',
}

/** Client ID in `username`, Client Secret in `apiToken` — the app's credential contract. */
export const credential: CredentialRef = {
  id: 'cred-1',
  name: 'Defender app registration',
  username: 'app-client-id',
  password: '',
  apiToken: 'app-client-secret',
  certificate: null,
}

export const platform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

export function makeCanvas(entityType: string, items: CanvasItemSnapshot[]): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: entityType,
    toolType: 'defender-endpoint',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

function base(entityType: string, items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: entityType,
    canvas: makeCanvas(entityType, items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: TENANT },
    platform,
  }
}

export function deployCtx(
  entityType: string,
  items: CanvasItemSnapshot[],
  overrides: Partial<DeployContext> = {},
): DeployContext {
  return {
    ...base(entityType, items),
    component,
    credential,
    connectivity: null,
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
    ...overrides,
  }
}

export function rollbackCtx(
  entityType: string,
  rollbackData: unknown,
  overrides: Partial<RollbackContext> = {},
): RollbackContext {
  return {
    ...base(entityType, []),
    component,
    credential,
    connectivity: null,
    connectivityProvider: null,
    rollbackData,
    targetVersion: makeCanvas(entityType, []),
    ...overrides,
  }
}

/**
 * Drift reads `deployedConfig`, NOT the live canvas — so the canvas is left
 * empty here on purpose, and a handler that read the wrong one finds nothing.
 */
export function driftCtx(
  entityType: string,
  deployedItems: CanvasItemSnapshot[],
  overrides: Partial<DriftContext> = {},
): DriftContext {
  return {
    ...base(entityType, []),
    component,
    credential,
    connectivity: null,
    connectivityProvider: null,
    deployedConfig: makeCanvas(entityType, deployedItems),
    ...overrides,
  }
}

export function healthCtx(
  entityType: string,
  items: CanvasItemSnapshot[],
  overrides: Partial<HealthCheckContext> = {},
): HealthCheckContext {
  return {
    ...base(entityType, items),
    component,
    credential,
    connectivity: null,
    connectivityProvider: null,
    ...overrides,
  }
}

export function statusCtx(entityType: string, overrides: Partial<PipelineContext> = {}): PipelineContext {
  return { ...base(entityType, []), ...overrides }
}
