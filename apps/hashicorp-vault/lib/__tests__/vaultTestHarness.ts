// =============================================================================
// Shared fake-Vault harness for the acting handlers (deploy / rollback /
// healthCheck / driftDetect).
//
// Every configuration type in this app reaches Vault through `VaultClient` in
// lib/vault.ts, which uses global `fetch` and reads only `status` and `text()`
// off the response. Stubbing `globalThis.fetch` therefore drives a handler end
// to end — its request sequence, its bodies, its headers, its error handling
// and the rollback state it records — with no module mocking and no new
// dependency.
//
// Pattern borrowed from apps/crowdstrike-edr/config-types/cloud-groups/
// __tests__/deploy.test.ts, adapted for Vault's static-token auth: there is no
// OAuth exchange, the token rides on every request as `X-Vault-Token`, and a
// 404 means "absent" rather than "failed".
// =============================================================================

import type {
  CanvasSnapshot,
  DeployContext,
  DriftContext,
  HealthCheckContext,
  PipelineContext,
  PlatformDataApi,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

/** A distinctive token so a leak into any message is unmistakable. */
export const VAULT_TOKEN = 'hvs.SUPERSECRET-vault-token-must-never-leak'
export const VAULT_HOST = 'https://vault.example.com:8200'
/** Every request the client builds is rooted here. */
export const VAULT_BASE = `${VAULT_HOST}/v1`

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export interface CannedResponse {
  status?: number
  /** Object (JSON-stringified) or a raw string body. */
  body?: unknown
}

export interface FetchRecorder {
  calls: RecordedCall[]
  restore: () => void
  /** Calls whose URL path contains `fragment`. */
  matching: (fragment: string | RegExp) => RecordedCall[]
}

/**
 * Replace global fetch with a queue of canned responses, recording every call.
 *
 * Responses are consumed in order. Running off the end is deliberately LOUD — a
 * 599 with a Vault-shaped error body — because a silent benign default would
 * let an under-specified test read an unqueued GET as "the object exists".
 */
export function recordFetch(responses: CannedResponse[]): FetchRecorder {
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
      headers: { ...(init?.headers ?? {}) },
      body: typeof init?.body === 'string' ? init.body : '',
    })

    const next = queue.shift() ?? {
      status: 599,
      body: { errors: [`no canned response queued for ${init?.method ?? 'GET'} ${String(input)}`] },
    }
    const status = next.status ?? 200
    return {
      status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})),
    }
  }) as unknown as typeof globalThis.fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
    matching: (fragment) =>
      calls.filter((c) => (fragment instanceof RegExp ? fragment.test(c.url) : c.url.includes(fragment))),
  }
}

/** Vault answers a successful write with 204 and no body. */
export const NO_CONTENT: CannedResponse = { status: 204, body: '' }
/** Vault answers a read for something absent with 404. */
export const NOT_FOUND: CannedResponse = { status: 404, body: { errors: [] } }
/** A permission failure, the most common real-world vendor rejection. */
export const FORBIDDEN: CannedResponse = {
  status: 403,
  body: { errors: ['1 error occurred:\n\t* permission denied\n\n'] },
}
/** GET /sys/health on a healthy, unsealed, active node. */
export const HEALTHY: CannedResponse = {
  status: 200,
  body: { initialized: true, sealed: false, standby: false },
}
/** GET /auth/token/lookup-self for an accepted token. */
export const TOKEN_OK: CannedResponse = {
  status: 200,
  body: { data: { display_name: 'token', policies: ['root'] } },
}

export const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

/** Build a canvas snapshot from plain sections, matching how the app reads it. */
export function makeCanvas(
  sections: Array<{ name: string; fields: Record<string, unknown> }>,
  entityType = 'vault-config',
): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'hashicorp-vault',
    entityType,
    items: sections,
    sections,
    snapshot: {},
  }
}

interface BaseOverrides {
  hostname?: string
  /** Pass null to exercise the "no credential configured" path. */
  token?: string | null
  settings?: Record<string, unknown>
}

function baseContext(canvas: CanvasSnapshot, o: BaseOverrides = {}): PipelineContext {
  const token = o.token === undefined ? VAULT_TOKEN : o.token
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'vault-config',
    canvas,
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: o.settings ?? {},
    platform: stubPlatform,
    component: {
      id: 'comp-1',
      hostname: o.hostname ?? VAULT_HOST,
      port: '8200',
      type: ['vault-cluster'],
      toolId: 'tool-1',
    },
    credential:
      token === null
        ? null
        : {
            id: 'cred-1',
            name: 'vault',
            username: '',
            password: '',
            apiToken: token,
            certificate: null,
          },
  }
}

export function makeDeployContext(canvas: CanvasSnapshot, o: BaseOverrides = {}): DeployContext {
  return {
    ...baseContext(canvas, o),
    connectivity: null,
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  } as DeployContext
}

export function makeRollbackContext(
  canvas: CanvasSnapshot,
  rollbackData: unknown,
  o: BaseOverrides = {},
): RollbackContext {
  return {
    ...baseContext(canvas, o),
    connectivity: null,
    connectivityProvider: null,
    rollbackData,
    targetVersion: canvas,
  } as RollbackContext
}

export function makeHealthCheckContext(canvas: CanvasSnapshot, o: BaseOverrides = {}): HealthCheckContext {
  return {
    ...baseContext(canvas, o),
    connectivity: null,
    connectivityProvider: null,
  } as HealthCheckContext
}

export function makeDriftContext(canvas: CanvasSnapshot, o: BaseOverrides = {}): DriftContext {
  return {
    ...baseContext(canvas, o),
    connectivity: null,
    connectivityProvider: null,
    deployedConfig: canvas,
  } as DriftContext
}

/**
 * Assert the Vault token never escapes into anything a user or a log will see.
 * A leaked token in a pipeline message is a credential disclosure.
 */
export function assertNoTokenLeak(...values: unknown[]): void {
  for (const value of values) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    if (text.includes(VAULT_TOKEN)) {
      throw new Error(`Vault token leaked into handler output: ${text}`)
    }
  }
}
