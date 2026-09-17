// =============================================================================
// Fake Panorama — the shared vendor stub every palo-alto-panorama handler test
// drives.
//
// `validate` was the only handler with tests in this app; the five that reach a
// customer's Panorama and change its candidate configuration (deploy, rollback,
// healthCheck, driftDetect) or report on it (getStatus) had none.
//
// Every handler here reaches Panorama through `lib/panorama.ts`, which uses
// global `fetch`, so replacing `globalThis.fetch` with a queue of canned
// responses drives a handler end to end — its request sequence, the REST entry
// bodies it writes, its error handling and the rollback state it records — with
// no module mocking and no new dependency.
//
// This file is NOT a test file (the runner only collects `*.test.ts`); it is the
// harness those tests import.
//
// What Panorama makes different, and what the recorder therefore parses:
//
//   * TWO APIs on one host. Objects and policies go over REST —
//     `https://<host>/restapi/<version><resourcePath>` with the target addressed
//     entirely in the QUERY STRING (`location`, `device-group`, `name`) and a
//     `{ entry: [ { "@name": ... } ] }` JSON body. Commits go over the XML API —
//     `https://<host>/api?type=commit&cmd=<commit></commit>`. Asserting "a POST
//     happened" would say nothing, so every recorded call is parsed into which
//     API it hit, the resource path, the location it was scoped to, the object
//     it named, and the fields it carried.
//
//   * The device group IS the blast radius. `location=shared` writes to every
//     device group Panorama manages; `location=device-group&device-group=X`
//     writes to one. A handler that drops the device-group scoping pushes a
//     customer's rule set far wider than they asked for, so {@link DEVICE_GROUP}
//     is deliberately not "shared" and the suites assert the scoping on the wire.
//
//   * The XML API reports failure INSIDE a 200. `<response status="error">` with
//     HTTP 200 is how a commit lock, a permission denial or a config error comes
//     back, so {@link commitRejected} builds exactly that and the deploy suite
//     asserts it is treated as a failed deploy rather than a successful one.
//
//   * Auth is a pre-generated API key in the `X-PAN-KEY` header, not a login.
//     There is no session to establish, so the FIRST call a handler makes is
//     already a real request — and that key is a full administrator bearer for
//     the Panorama. It must never appear in a result message, an artifact,
//     rollbackData or a drift diff; {@link leaksSecret} proves it does not.
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

// --- Identity of the fake Panorama -------------------------------------------

export const HOST = 'panorama.example.com'
export const BASE_URL = `https://${HOST}`
export const REST_VERSION = 'v11.0'
export const REST_BASE = `${BASE_URL}/restapi/${REST_VERSION}`
export const XML_ENDPOINT = `${BASE_URL}/api`

/**
 * The device group the suites deploy to. NOT "shared" on purpose: shared writes
 * reach every device group Panorama manages, so a handler that forgets the
 * scoping would still pass against a "shared" fixture.
 */
export const DEVICE_GROUP = 'DG-Edge'

/** The connection admin. Veltrix's own config-log rows are attributed to it. */
export const ADMIN_USER = 'veltrix-svc'

/**
 * The PAN-OS API key. Distinctive on purpose: a result message, artifact,
 * rollbackData or diff carrying this string has leaked a full Panorama
 * administrator bearer token into platform records an operator can read.
 */
export const API_KEY = 'panorama-api-key-MUST-NOT-LEAK'

/**
 * The admin password on the same credential. `resolvePanoramaApiKey` falls back
 * to it, so it is equally a Panorama credential and equally must not surface.
 */
export const ADMIN_PASSWORD = 'panorama-admin-password-MUST-NOT-LEAK'

// --- The fake transport -------------------------------------------------------

/** One outbound Panorama call, as the fake saw it. */
export interface PanoramaCall {
  /** The full request URL. */
  url: string
  /** The HTTP verb. */
  method: string
  /** Which of Panorama's two APIs this call hit. */
  api: 'rest' | 'xml' | 'other'
  /** REST API version segment from the path, e.g. "v11.0". */
  restVersion: string
  /** REST resource path below the version, e.g. "/Objects/Addresses". */
  resourcePath: string
  /** The `location` query param: "shared" | "device-group". */
  location: string
  /** The `device-group` query param; '' when absent. */
  deviceGroup: string
  /** The `name` query param; '' when absent. */
  name: string
  /**
   * Whether a `name` was addressed at all. A write or DELETE with `hasName:
   * false` is aimed at the WHOLE collection, not one object.
   */
  hasName: boolean
  /** `entry[0]["@name"]` from the JSON body. */
  entryName: string
  /** `entry[0]["@location"]` from the JSON body. */
  entryLocation: string
  /** `entry[0]["@device-group"]` from the JSON body; '' when absent. */
  entryDeviceGroup: string
  /** `entry[0]` with the identity attributes removed — the managed fields. */
  fields: Record<string, unknown>
  /** XML API `type` param: "commit" | "op" | "log". */
  xmlType: string
  /** XML API `cmd` param. */
  xmlCmd: string
  /** Every XML API query param, for the assertions that want the rest. */
  xmlParams: Record<string, string>
  /** The `X-PAN-KEY` header value; null when the call carried no key. */
  apiKey: string | null
  /** The raw serialised body, for the rare assertion that wants it verbatim. */
  body: string
}

/** One canned Panorama response, consumed in order. */
export interface CannedResponse {
  /** HTTP status. The XML API answers 200 even for logical failures. */
  status?: number
  /** A string is returned verbatim; anything else is JSON-stringified. */
  body?: unknown
}

export interface FakePanorama {
  calls: PanoramaCall[]
  restore: () => void
}

const IDENTITY_KEYS = new Set(['@name', '@location', '@device-group'])

function headerValue(headers: unknown, key: string): string | null {
  if (!headers || typeof headers !== 'object') return null
  const record = headers as Record<string, unknown>
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function parseCall(rawUrl: string, method: string, rawBody: unknown, headers: unknown): PanoramaCall {
  const body = typeof rawBody === 'string' ? rawBody : ''
  const call: PanoramaCall = {
    url: rawUrl,
    method,
    api: 'other',
    restVersion: '',
    resourcePath: '',
    location: '',
    deviceGroup: '',
    name: '',
    hasName: false,
    entryName: '',
    entryLocation: '',
    entryDeviceGroup: '',
    fields: {},
    xmlType: '',
    xmlCmd: '',
    xmlParams: {},
    apiKey: headerValue(headers, 'X-PAN-KEY'),
    body,
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return call
  }

  const restMatch = /^\/restapi\/(v\d+\.\d+)(\/.*)$/.exec(url.pathname)
  if (restMatch) {
    call.api = 'rest'
    call.restVersion = restMatch[1]
    call.resourcePath = restMatch[2]
    call.location = url.searchParams.get('location') ?? ''
    call.deviceGroup = url.searchParams.get('device-group') ?? ''
    call.hasName = url.searchParams.has('name')
    call.name = url.searchParams.get('name') ?? ''
    if (body) {
      try {
        const parsed = JSON.parse(body) as { entry?: Array<Record<string, unknown>> }
        const entry = parsed.entry?.[0] ?? {}
        call.entryName = typeof entry['@name'] === 'string' ? (entry['@name'] as string) : ''
        call.entryLocation = typeof entry['@location'] === 'string' ? (entry['@location'] as string) : ''
        call.entryDeviceGroup =
          typeof entry['@device-group'] === 'string' ? (entry['@device-group'] as string) : ''
        for (const [key, value] of Object.entries(entry)) {
          if (!IDENTITY_KEYS.has(key)) call.fields[key] = value
        }
      } catch {
        // A body that is not JSON is itself worth seeing in a failure message.
      }
    }
    return call
  }

  if (url.pathname === '/api') {
    call.api = 'xml'
    for (const [key, value] of url.searchParams.entries()) call.xmlParams[key] = value
    call.xmlType = call.xmlParams.type ?? ''
    call.xmlCmd = call.xmlParams.cmd ?? ''
  }
  return call
}

/**
 * What a queue that has run out answers with: HTTP 200 and an empty body.
 *
 * Empty parses as an empty REST collection and as an XML response with no job,
 * so an unfixtured call never blocks on a poll. Every suite still asserts its
 * exact call sequence, so this default cannot silently absorb a call the handler
 * should not have made.
 */
const EXHAUSTED: CannedResponse = { status: 200, body: '' }

/** Replace global fetch with a queue of canned responses, recording every call. */
export function recordPanorama(responses: CannedResponse[]): FakePanorama {
  const calls: PanoramaCall[] = []
  const queue = [...responses]
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: unknown },
  ) => {
    calls.push(parseCall(String(input), init?.method ?? 'GET', init?.body, init?.headers))
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
 * A Panorama that cannot be reached at all — every fetch rejects, the way a DNS
 * failure, a refused connection or an aborted request surfaces. A handler must
 * turn that into a failed RESULT, not a throw, or the pipeline reports an opaque
 * crash instead of a message the operator can act on.
 */
export function recordUnreachablePanorama(reason = 'ECONNREFUSED 10.9.9.9:443'): FakePanorama {
  const calls: PanoramaCall[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (
    input: unknown,
    init?: { method?: string; body?: unknown; headers?: unknown },
  ) => {
    calls.push(parseCall(String(input), init?.method ?? 'GET', init?.body, init?.headers))
    throw new Error(reason)
  }) as unknown as typeof globalThis.fetch

  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** Run `fn` against a canned Panorama, always restoring global fetch. */
export async function withPanorama(
  responses: CannedResponse[],
  fn: (calls: PanoramaCall[]) => Promise<void>,
): Promise<void> {
  const fake = recordPanorama(responses)
  try {
    await fn(fake.calls)
  } finally {
    fake.restore()
  }
}

/** Run `fn` against a Panorama that cannot be reached. */
export async function withUnreachablePanorama(
  fn: (calls: PanoramaCall[]) => Promise<void>,
  reason?: string,
): Promise<void> {
  const fake = recordUnreachablePanorama(reason)
  try {
    await fn(fake.calls)
  } finally {
    fake.restore()
  }
}

// --- Canned REST responses ----------------------------------------------------

/** A REST collection listing. `entry` is an array, the multi-object shape. */
export function listOk(entries: Array<Record<string, unknown>>): CannedResponse {
  return { status: 200, body: { '@status': 'success', '@code': '19', result: { entry: entries } } }
}

/**
 * A REST collection holding exactly ONE object, which PAN-OS serialises as a
 * bare object rather than a one-element array. A handler that assumes an array
 * sees no existing objects at all and creates a duplicate.
 */
export function listSingle(entry: Record<string, unknown>): CannedResponse {
  return { status: 200, body: { '@status': 'success', '@code': '19', result: { entry } } }
}

/** A successful REST write. */
export const WRITE_OK: CannedResponse = { status: 200, body: { '@status': 'success', '@code': '20' } }

/** A REST write or read refused with an HTTP error and a JSON error body. */
export function restError(status: number, message: string, code = '12'): CannedResponse {
  return { status, body: { '@status': 'error', '@code': code, message: [message] } }
}

/**
 * A REST error that arrives as XML on the REST endpoint — PAN-OS does this, and
 * `panoramaErrorMessage` reads the `<line>` out of it.
 */
export function restXmlError(status: number, line: string): CannedResponse {
  return {
    status,
    body: `<response status="error" code="12"><msg><line>${line}</line></msg></response>`,
  }
}

/** A DELETE of an object that is already gone. */
export const DELETE_NOT_FOUND: CannedResponse = restError(404, 'Object not present', '7')

// --- Canned XML API responses -------------------------------------------------

/** A commit that was accepted and enqueued as `jobId`. */
export function commitQueued(jobId: string): CannedResponse {
  return {
    status: 200,
    body:
      `<response status="success" code="19"><result>` +
      `<msg><line>Commit job enqueued with jobid ${jobId}</line></msg>` +
      `<job>${jobId}</job></result></response>`,
  }
}

/** The commit the candidate had nothing to activate. */
export const COMMIT_NO_CHANGES: CannedResponse = {
  status: 200,
  body: '<response status="success" code="19"><msg>There are no changes to commit.</msg></response>',
}

/**
 * A REFUSED commit — HTTP 200 carrying `status="error"`, which is how a commit
 * lock, a config error or a permission denial actually comes back. A handler
 * that reads only the HTTP status reports the deploy as activated.
 */
export function commitRejected(line: string): CannedResponse {
  return {
    status: 200,
    body: `<response status="error" code="403"><msg><line>${line}</line></msg></response>`,
  }
}

/** A finished commit job. `result` is "OK" for success, "FAIL" for a failure. */
export function commitJobFinished(jobId: string, result: 'OK' | 'FAIL' = 'OK'): CannedResponse {
  return {
    status: 200,
    body:
      `<response status="success"><result><job>` +
      `<id>${jobId}</id><tenq>2026/09/16 10:00:00</tenq><status>FIN</status><result>${result}</result>` +
      `</job></result></response>`,
  }
}

/** The pair of XML calls a successful auto-commit makes. */
export function commitOk(jobId = '4242'): CannedResponse[] {
  return [commitQueued(jobId), commitJobFinished(jobId, 'OK')]
}

// --- Canned config-log (drift attribution) responses --------------------------

/**
 * The config audit log is unreadable — the only shape that costs ONE call and no
 * polling, which is what most suites want when attribution is beside the point.
 */
export const CONFIG_LOG_UNAVAILABLE: CannedResponse = { status: 403, body: '' }

/** One config-log row, as `parseConfigLogEntries` reads it. */
export interface ConfigLogRow {
  admin: string
  cmd: string
  timeGenerated: string
  path: string
  result?: string
}

/** The response to the `type=log` call that STARTS a config-log query. */
export function configLogStarted(jobId = '7'): CannedResponse {
  return { status: 200, body: `<response status="success"><result><job>${jobId}</job></result></response>` }
}

/** The response to the `action=get` poll that RETURNS the config-log rows. */
export function configLogRows(rows: ConfigLogRow[]): CannedResponse {
  const entries = rows
    .map(
      (row) =>
        `<entry><admin>${row.admin}</admin><cmd>${row.cmd}</cmd>` +
        `<time_generated>${row.timeGenerated}</time_generated>` +
        `<path>${row.path}</path><full-path>${row.path}</full-path>` +
        `<result>${row.result ?? 'Succeeded'}</result></entry>`,
    )
    .join('')
  return {
    status: 200,
    body: `<response status="success"><result><job><status>FIN</status></job><log><logs>${entries}</logs></log></result></response>`,
  }
}

/** The two XML calls one object's attribution query makes. */
export function configLog(rows: ConfigLogRow[], jobId = '7'): CannedResponse[] {
  return [configLogStarted(jobId), configLogRows(rows)]
}

// --- Call predicates ----------------------------------------------------------

export function restCalls(calls: PanoramaCall[]): PanoramaCall[] {
  return calls.filter((call) => call.api === 'rest')
}

export function xmlCalls(calls: PanoramaCall[]): PanoramaCall[] {
  return calls.filter((call) => call.api === 'xml')
}

/**
 * Calls that CHANGE a customer's Panorama configuration: every REST call that is
 * not a GET, plus every commit (which ACTIVATES the candidate config across the
 * device group, whether or not this handler wrote it). A read-only handler must
 * make none of either.
 */
export function mutatingCalls(calls: PanoramaCall[]): PanoramaCall[] {
  return calls.filter(
    (call) => (call.api === 'rest' && call.method !== 'GET') || (call.api === 'xml' && call.xmlType === 'commit'),
  )
}

/** The commit requests, in the order they were made. */
export function commitCalls(calls: PanoramaCall[]): PanoramaCall[] {
  return calls.filter((call) => call.api === 'xml' && call.xmlType === 'commit')
}

/** The config-log (drift attribution) requests. */
export function configLogCalls(calls: PanoramaCall[]): PanoramaCall[] {
  return calls.filter((call) => call.api === 'xml' && call.xmlType === 'log')
}

/** True when the API key or the admin password appears anywhere in `value`. */
export function leaksSecret(value: unknown): boolean {
  const json = JSON.stringify(value ?? null) ?? ''
  return json.includes(API_KEY) || json.includes(ADMIN_PASSWORD)
}

interface Asserter {
  ok: (v: unknown, m?: string) => void
  equal: (a: unknown, b: unknown, m?: string) => void
  deepEqual: (a: unknown, b: unknown, m?: string) => void
}

/**
 * Assert every call authenticated with the API key and was scoped to the
 * configured device group rather than shared. Both are per-call properties —
 * there is no login to check once — so this runs over the whole sequence.
 */
export function assertScopedAndAuthenticated(
  assert: Asserter,
  calls: PanoramaCall[],
  deviceGroup: string = DEVICE_GROUP,
): void {
  assert.ok(calls.length > 0, 'handler made no call at all')
  for (const call of calls) {
    assert.equal(call.apiKey, API_KEY, `call without the API key: ${call.method} ${call.url}`)
    if (call.api !== 'rest') continue
    assert.equal(call.restVersion, REST_VERSION, `wrong REST version: ${call.url}`)
    assert.equal(call.location, 'device-group', `call not scoped to a device group: ${call.url}`)
    assert.equal(call.deviceGroup, deviceGroup, `call scoped to the wrong device group: ${call.url}`)
  }
}

// --- Canvas + context ---------------------------------------------------------

/** Shorthand for one canvas item. */
export function item(name: string, fields: Record<string, unknown> = {}, id?: string): CanvasItemSnapshot {
  return id === undefined ? { name, fields } : { id, name, fields }
}

/** Build a canvas snapshot from a list of items. `items` and `sections` alias. */
export function canvas(items: CanvasItemSnapshot[], entityType = 'palo-alto-panorama'): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 4,
    name: 'Test Canvas',
    toolType: 'palo-alto-panorama',
    entityType,
    items,
    sections: items,
    snapshot: {},
  }
}

export const CREDENTIAL: CredentialRef = {
  id: 'cred-1',
  name: 'Panorama admin',
  username: ADMIN_USER,
  password: ADMIN_PASSWORD,
  apiToken: API_KEY,
  certificate: null,
}

/** A credential that is configured but carries no usable key in either field. */
export const CREDENTIAL_WITHOUT_KEY: CredentialRef = { ...CREDENTIAL, apiToken: '   ', password: '' }

export const COMPONENT: ComponentRef = {
  id: 'comp-1',
  hostname: HOST,
  port: '443',
  type: ['panorama'],
  toolId: 'palo-alto-panorama',
}

/** A component registered with no hostname — nothing to address. */
export const COMPONENT_WITHOUT_HOSTNAME: ComponentRef = { ...COMPONENT, hostname: '   ' }

/** Per-test overrides — everything else is a working connection to Panorama. */
export interface ContextOverrides {
  /** `null` models a config type deployed with no credential configured. */
  credential?: CredentialRef | null
  /** Replaces the default settings entirely. */
  settings?: Record<string, unknown>
  /** Turn on the commit-after-write behaviour (`auto_commit`). */
  autoCommit?: boolean
  /** Deploy to a different device group, or to "shared". */
  deviceGroup?: string
  component?: ComponentRef
  /** Canvas items for `deployedConfig`, when drift should see a different desired state. */
  deployedItems?: CanvasItemSnapshot[]
}

export function settingsFor(over: ContextOverrides): Record<string, unknown> {
  if (over.settings) return over.settings
  return {
    rest_api_version: REST_VERSION,
    device_group: over.deviceGroup ?? DEVICE_GROUP,
    auto_commit: over.autoCommit ?? false,
    verify_tls: true,
  }
}

function platformApi(): PlatformDataApi {
  return {
    getLatestDeployment: async () => null,
    listComponents: async () => [],
  }
}

function baseContext(over: ContextOverrides) {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'palo-alto-panorama',
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: settingsFor(over),
    platform: platformApi(),
    component: over.component ?? COMPONENT,
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
    deployedConfig: canvas(over.deployedItems ?? items),
  } as unknown as DriftContext
}

// --- getStatus ----------------------------------------------------------------
// getStatus is the one handler that never touches Panorama: it reads the
// platform's own deployment record through `ctx.platform`. It is code-identical
// across all 23 configuration types, so its contract is shared.

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
  /** Each `listComponents` call, in order. */
  componentQueries: Array<{ types?: string[] } | undefined>
}

/**
 * Build a PipelineContext whose platform API returns `latest` and `components`,
 * recording every query the handler makes against it.
 */
export function statusContext(
  configTypeId: string,
  opts: {
    latest: DeploymentSummary | null
    components?: ComponentRef[]
    version?: number
  } = { latest: null },
): StatusProbe {
  const deploymentQueries: StatusProbe['deploymentQueries'] = []
  const componentQueries: StatusProbe['componentQueries'] = []

  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, args) => {
      deploymentQueries.push({ canvasId, status: args?.status })
      return opts.latest
    },
    listComponents: async (filter) => {
      componentQueries.push(filter)
      return opts.components ?? [COMPONENT]
    },
  }

  const ctx = {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId,
    canvas: { ...canvas([], configTypeId), version: opts.version ?? 4 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: settingsFor({}),
    platform,
    component: COMPONENT,
    credential: CREDENTIAL,
  } as unknown as PipelineContext

  return { ctx, deploymentQueries, componentQueries }
}
