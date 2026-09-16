// =============================================================================
// Fake Keycloak — the shared vendor stub every Keycloak handler test drives.
//
// `validate` was the only handler with tests; the five that actually reach a
// customer's realm (deploy, rollback, healthCheck, driftDetect, getStatus) had
// none. A silent failure here breaks authentication for everyone in a realm.
//
// Unlike the 89 apps that reach their vendor through global `fetch`, this app
// goes through `node:https` (lib/keycloakApi.ts uses it directly so the
// platform's fetch settings cannot reject Keycloak's self-signed certificate).
// The existing test files say that is "impractical to mock" — it is not.
// Node's ESM named exports for a builtin are live bindings that
// `module.syncBuiltinESMExports()` republishes, so replacing `https.request`
// and calling that function drives a real handler end to end: its request
// sequence, its bodies, its Authorization header, its TLS posture, its error
// handling and the rollback state it records. No module mocking, no new
// dependency, no change to handler source.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is
// the harness those tests import. Every helper here is deliberately small: a
// test that has to fight its fixtures stops being evidence about the handler.
// =============================================================================

import { EventEmitter } from 'node:events'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import type {
  CanvasItemSnapshot,
  CanvasSnapshot,
  ComponentRef,
  CredentialRef,
  DeployContext,
  DriftContext,
  HealthCheckContext,
  RollbackContext,
} from '@veltrixsecops/app-sdk'

// --- The fake transport -------------------------------------------------------

/** One outbound request the handler made, as the fake saw it. */
export interface RecordedCall {
  /** Full reconstructed URL, e.g. `https://keycloak.example.com/admin/realms/corp/clients`. */
  url: string
  /** The raw `path` (pathname + search) the handler asked node:https for. */
  path: string
  method: string
  /** The serialised request body, or '' for a body-less request. */
  body: string
  /** The `Authorization` header, including the `Bearer ` prefix, or null. */
  authorization: string | null
  contentType: string | null
  /** True only when the handler demanded a valid TLS certificate. */
  rejectUnauthorized: boolean
}

/** One canned Keycloak response, consumed in order. */
export interface CannedResponse {
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
  /** Response headers (e.g. `location` on a 201 create). */
  headers?: Record<string, string>
  /** When set, the request emits this as a transport error instead of responding. */
  error?: string
}

export interface FakeKeycloak {
  calls: RecordedCall[]
  restore: () => void
}

interface FakeRequest extends EventEmitter {
  write: (chunk: unknown) => void
  end: () => void
  destroy: (err?: Error) => void
  setTimeout?: (ms: number) => void
}

interface FakeResponse extends EventEmitter {
  statusCode: number
  headers: Record<string, string>
}

/**
 * Replace `https.request` with a queue of canned responses, recording every
 * call. Responses are consumed in order; a request past the end of the queue
 * gets an empty JSON array, so a trailing best-effort read never needs
 * fixturing. ALWAYS call `restore()` in a `finally` — one test's stub leaking
 * into the next is the classic way to get a green suite that proves nothing.
 */
export function recordKeycloak(responses: CannedResponse[]): FakeKeycloak {
  const calls: RecordedCall[] = []
  const queue = [...responses]
  const original = https.request

  const fake = (options: unknown, callback: (res: FakeResponse) => void): FakeRequest => {
    const opts = options as {
      hostname?: string
      port?: string | number
      path?: string
      method?: string
      headers?: Record<string, string>
      rejectUnauthorized?: boolean
    }
    const port = String(opts.port ?? 443)
    const headers = opts.headers ?? {}
    const call: RecordedCall = {
      url: `https://${opts.hostname ?? ''}${port === '443' ? '' : `:${port}`}${opts.path ?? ''}`,
      path: opts.path ?? '',
      method: opts.method ?? 'GET',
      body: '',
      authorization: headers.Authorization ?? null,
      contentType: headers['Content-Type'] ?? null,
      rejectUnauthorized: opts.rejectUnauthorized === true,
    }
    calls.push(call)

    const req = new EventEmitter() as FakeRequest
    req.write = (chunk: unknown) => {
      call.body += String(chunk)
    }
    req.destroy = () => {}
    req.setTimeout = () => {}
    req.end = () => {
      const next = queue.shift() ?? { status: 200, body: [] }
      // Defer so the caller has attached its 'error' handler and returned.
      setImmediate(() => {
        if (next.error) {
          req.emit('error', new Error(next.error))
          return
        }
        const res = new EventEmitter() as FakeResponse
        res.statusCode = next.status ?? 200
        res.headers = next.headers ?? { 'content-type': 'application/json' }
        callback(res)
        // Defer again so the response's own 'data'/'end' listeners are attached.
        setImmediate(() => {
          const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {})
          res.emit('data', Buffer.from(payload, 'utf8'))
          res.emit('end')
        })
      })
    }
    return req
  }

  ;(https as unknown as { request: unknown }).request = fake
  syncBuiltinESMExports()

  return {
    calls,
    restore: () => {
      ;(https as unknown as { request: unknown }).request = original
      syncBuiltinESMExports()
    },
  }
}

// --- Canned responses ---------------------------------------------------------

/**
 * The admin bearer token the fake token endpoint hands out. Distinctive on
 * purpose: a result message, artifact, rollbackData or diff carrying this
 * string has leaked the realm's admin credential into platform storage.
 */
export const ADMIN_TOKEN = 'kc-admin-access-token-MUST-NOT-LEAK'

/**
 * The OAuth2 token response. `expires_in` is comfortably past the client's 30s
 * refresh margin, so one handler run performs exactly one token exchange.
 */
export const TOKEN: CannedResponse = {
  status: 200,
  body: { access_token: ADMIN_TOKEN, expires_in: 300, token_type: 'Bearer' },
}

/** A token endpoint that rejects the credential (bad secret / missing role). */
export const TOKEN_DENIED: CannedResponse = {
  status: 401,
  body: { error: 'invalid_client', error_description: 'Invalid client credentials' },
}

/** A 200 carrying a JSON body. */
export function ok(body: unknown = {}): CannedResponse {
  return { status: 200, body }
}

/** A 201 create acknowledgement; Keycloak returns the new id only in `location`. */
export function created(location?: string): CannedResponse {
  return { status: 201, body: '', headers: location ? { location } : {} }
}

/** A 204 write acknowledgement — what Keycloak returns from most PUT/DELETEs. */
export function noContent(): CannedResponse {
  return { status: 204, body: '' }
}

/** A Keycloak error body (`{error, errorMessage}`) at the given status. */
export function kcError(status: number, message = 'error'): CannedResponse {
  return { status, body: { error: message, errorMessage: message } }
}

/** A 404 — Keycloak's "this object does not exist" for a get-by-identity path. */
export function notFound(): CannedResponse {
  return { status: 404, body: { error: 'Not found' } }
}

/** A transport-level failure (connection refused, TLS error, timeout). */
export function transportError(message = 'ECONNREFUSED'): CannedResponse {
  return { error: message }
}

// --- Call predicates ----------------------------------------------------------

export const KEYCLOAK_HOST = 'keycloak.example.com'
/** The managed realm — deliberately NOT `master`, so a hardcoded realm shows up. */
export const REALM = 'corp'
/** The realm that issues the admin token (settings.auth_realm defaults to master). */
export const AUTH_REALM = 'master'
/** Every admin call is rooted here. */
export const ADMIN_BASE = `/admin/realms/${REALM}`
/** The one endpoint an admin token may come from. */
export const TOKEN_PATH = `/realms/${AUTH_REALM}/protocol/openid-connect/token`

export function isTokenCall(call: RecordedCall): boolean {
  return /\/realms\/[^/]+\/protocol\/openid-connect\/token$/.test(call.path)
}

/** Every call that is not the OAuth2 token exchange — the real work. */
export function vendorCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => !isTokenCall(call))
}

/** Calls that CHANGE something. A read-only handler must make none of these. */
export function writeCalls(calls: RecordedCall[]): RecordedCall[] {
  return vendorCalls(calls).filter((call) => call.method !== 'GET')
}

/** The handler-relative path (what the handler passed to `admin.get`/`post`/…). */
export function adminPath(call: RecordedCall): string {
  return call.path.startsWith(ADMIN_BASE) ? call.path.slice(ADMIN_BASE.length) : call.path
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

/** True when the admin token appears anywhere in the given value. */
export function leaksToken(value: unknown): boolean {
  return JSON.stringify(value ?? null)?.includes(ADMIN_TOKEN) ?? false
}

/**
 * Assert-friendly: every place a handler result can carry data back to the
 * platform, flattened into one value. Used to prove a secret never escapes.
 */
export function resultSurface(result: unknown): unknown {
  return result
}

// --- Fixture constants --------------------------------------------------------

/** The primary grant: service-account client-id + client secret. */
export const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'Keycloak admin service account',
  username: 'veltrix-admin',
  password: 'admin-user-password',
  apiToken: 'veltrix-admin-client-secret',
  certificate: null,
}

/** The alternate grant: admin username + password against `admin-cli`. */
export const PASSWORD_CREDENTIAL: CredentialRef = {
  ...CREDENTIAL,
  apiToken: null,
}

export const COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: KEYCLOAK_HOST,
  port: '443',
  type: ['keycloak-realm'],
  toolId: 'keycloak',
}

/** Build a canvas snapshot from a list of items (one item = one resource). */
export function canvas(items: CanvasItemSnapshot[], entityType = 'keycloak'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'keycloak',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

/** Shorthand for one canvas item. */
export function item(name: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { id: `item-${name}`, name, fields }
}

/** Per-test overrides — everything else is a working connection to Keycloak. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no connection configured. */
  credential?: CredentialRef | null
  /** Merged over the defaults (`realm: corp`). */
  settings?: Record<string, unknown>
  hostname?: string
  port?: string
}

function baseContext(over: ContextOverrides) {
  return {
    appId: 'keycloak',
    customerId: 'cust-1',
    configTypeId: 'keycloak',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { realm: REALM, ...(over.settings ?? {}) },
    platform: {
      getLatestDeployment: async () => null,
      listComponents: async () => [],
    },
    component: {
      ...COMPONENT,
      hostname: over.hostname ?? KEYCLOAK_HOST,
      port: over.port ?? '443',
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
    deployedConfig: canvas(items),
  } as unknown as DriftContext
}
