// =============================================================================
// Reusable handler contracts for the Netskope app, built on fakeNetskope.
//
// Five of this app's six handlers are uniform across its 22 configuration types
// once the resource name is stripped out of them:
//
//   getStatus    — identical in every config type: it reads the platform's own
//                  deployment record and never touches Netskope.
//   healthCheck  — the same four steps everywhere: read the settings, fail closed
//                  if the credential or tenant host is unusable, probe ONE
//                  endpoint, report reachability.
//   deploy       — the same pre-flight refusals, then the same list → match →
//                  create-or-update → record shape for all 20 collection types.
//   rollback     — the same refusals, plus the rule that an entry with nothing
//                  recorded must make no call rather than write an invented value.
//   driftDetect  — the same rule that drift never writes and never turns a failed
//                  read into "these objects are missing".
//
// Writing 22 hand-copied variants of each would be 22 places for the assertion to
// drift. These register the shared contract; a config type's own test file calls
// it with a descriptor of its resource and adds what is genuinely specific —
// reference resolution, the url-list apply step, built-in preservation, and the
// write-only fields that must never reach rollbackData.
//
// This is NOT a test file — the runner only collects `*.test.ts`.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  CanvasItemSnapshot,
  ConfigStatus,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import {
  BASE_URL,
  CannedResponse,
  EMPTY_CREDENTIAL,
  NO_CONTENT,
  Route,
  API_TOKEN_CREDENTIAL,
  assertTokenSent,
  badRequest,
  bodyOf,
  created,
  deployContext,
  deploymentSummary,
  driftContext,
  forbidden,
  healthContext,
  leaksToken,
  list,
  netskopeError,
  notFound,
  npaData,
  npaList,
  ok,
  priorDeployment,
  recordFetch,
  rollbackContext,
  routeFetch,
  serverError,
  settingsWithoutTenant,
  statusContext,
  writeCalls,
} from './fakeNetskope'

/** Escape a literal API path for use inside a RegExp. */
export function pathRe(path: string): RegExp {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

// --- healthCheck --------------------------------------------------------------

export interface HealthCheckContract {
  /** The configuration type's id, used in test titles. */
  label: string
  handler: (ctx: HealthCheckContext) => Promise<HealthCheckResult>
  /** The path the reachability probe must hit, e.g. '/policy/urllist'. */
  probePath: string
  /** The name of the reachability check in the result. */
  checkName: string
  /** Whether the probe asks for one page — true for every collection type. */
  paged?: boolean
  /** Whether a 404 counts as reachable — true only where the resource may never have been set. */
  tolerates404?: boolean
}

/** Register the health-check contract every Netskope configuration type shares. */
export function registerHealthCheckContract(c: HealthCheckContract): void {
  const paged = c.paged ?? true

  test(`${c.label} healthCheck: refuses without a credential, without calling Netskope`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Netskope without a credential')
      assert.ok(
        result.checks.some((check) => check.name === 'credential' && check.passed === false),
        `expected a failed "credential" check, got ${result.checks.map((x) => x.name).join(', ')}`,
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses a credential carrying no token, without calling Netskope`, async () => {
    // The credential row exists but both secret fields are blank — there is no
    // Netskope-Api-Token to present, so there is nothing to try.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: EMPTY_CREDENTIAL }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Netskope with an unusable credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: accepts a token stored in the apiToken field`, async () => {
    // The library header and MISSING_CREDENTIAL_MESSAGE both tell the operator
    // they may store the token in either field. `password ?? apiToken` never
    // honoured that: the platform supplies `password` as '' rather than null, so
    // `??` short-circuits on the empty string and apiToken was dead code. A
    // tenant that followed the documentation got a silent, total refusal from
    // all six handlers — and drift returned `checked: false` forever, so nothing
    // ever alarmed.
    const { calls, restore } = recordFetch([ok({})])
    try {
      const result = await c.handler(healthContext([], { credential: API_TOKEN_CREDENTIAL }))

      assert.equal(result.healthy, true)
      assertTokenSent(assert, calls)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses when no tenant host is configured, without calling Netskope`, async () => {
    // The API base is built from the `tenant` setting; without it there is no
    // host to address, however good the token is.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { settings: settingsWithoutTenant() }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Netskope without a tenant host')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: probes its own endpoint with the API token and reports healthy`, async () => {
    const { calls, restore } = routeFetch([{ url: pathRe(c.probePath), respond: list([]) }])
    try {
      const result = await c.handler(healthContext([]))

      assertTokenSent(assert, calls)
      assert.equal(calls.length, 1, 'a reachability probe is exactly one request')
      assert.equal(calls[0].method, 'GET')
      assert.equal(calls[0].url.startsWith(`${BASE_URL}${c.probePath}`), true, `probe hit ${calls[0].url}`)
      if (paged) assert.match(calls[0].url, /limit=1&offset=0/)

      assert.equal(result.healthy, true)
      assert.equal(result.score, 100, 'score is a PERCENTAGE 0-100, not a fraction')
      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check, `expected a "${c.checkName}" check, got ${result.checks.map((x) => x.name).join(', ')}`)
      assert.equal(check.passed, true)
      assert.equal(typeof check.latencyMs, 'number')
      assert.equal(leaksToken(result), false, 'the health result must not carry the API token')
    } finally {
      restore()
    }
  })

  // NOTE: the documented `apiToken` fallback is deliberately NOT asserted here.
  // `lib/netskope.ts` resolves the token as `password ?? apiToken ?? ''`, and
  // `CredentialRef.password` is a non-optional string the platform supplies as
  // `''` when unset — so `??` short-circuits on the empty string and the apiToken
  // field is never read. A credential storing the token there resolves to "no
  // usable credential". Asserting the current behaviour would document the bug as
  // correct; see the report accompanying these tests.

  test(`${c.label} healthCheck: reports a rejected token rather than throwing`, async () => {
    const { calls, restore } = routeFetch([], forbidden('API token is not authorized for this endpoint'))
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /not authorized/)
      assert.equal(leaksToken(result), false, 'the failure message must not echo the API token')
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: surfaces the tenant's error rather than throwing`, async () => {
    const { calls, restore } = routeFetch([], serverError('Internal server error'))
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /Internal server error/)
      assert.equal(leaksToken(result), false)
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: a 404 is ${c.tolerates404 ? 'still reachable' : 'unhealthy'}`, async () => {
    const { restore } = routeFetch([], notFound())
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, Boolean(c.tolerates404))
      assert.equal(result.score, c.tolerates404 ? 100 : 0)
    } finally {
      restore()
    }
  })
}

// --- getStatus ----------------------------------------------------------------

export interface GetStatusContract {
  label: string
  handler: (ctx: PipelineContext) => Promise<ConfigStatus>
  /** The configuration type id, passed through to the context. */
  configTypeId: string
}

/**
 * Register the getStatus contract every Netskope configuration type shares — it
 * is identical in all 22, and it is the one handler that must never reach the
 * tenant.
 */
export function registerGetStatusContract(c: GetStatusContract): void {
  test(`${c.label} getStatus: reports not deployed when no successful deployment exists`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.configTypeId, { latest: null })
      const status = await c.handler(probe.ctx)

      assert.equal(status.deployed, false)
      assert.equal(status.lastDeployedAt, '')
      assert.equal(calls.length, 0, 'getStatus reads platform records only — it must not call Netskope')
      assert.deepEqual(probe.deploymentQueries, [{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
      assert.equal(status.componentStatuses.length, 1, 'the registered tenant is still reported, as not deployed')
      assert.equal(status.componentStatuses[0].deployed, false)
      assert.equal(status.componentStatuses[0].lastDeployedAt, undefined)
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: reports the completion time of the last successful deployment`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.configTypeId, { latest: deploymentSummary(), version: 11 })
      const status = await c.handler(probe.ctx)

      assert.equal(status.deployed, true)
      assert.equal(status.version, '11')
      assert.equal(status.lastDeployedAt, '2026-01-01T09:05:00.000Z')
      assert.equal(status.componentStatuses.length, 1)
      assert.equal(status.componentStatuses[0].componentId, 'comp-1')
      assert.equal(status.componentStatuses[0].hostname, 'acme.goskope.com')
      assert.equal(status.componentStatuses[0].deployed, true)
      assert.equal(status.componentStatuses[0].lastDeployedAt, '2026-01-01T09:05:00.000Z')
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: falls back to the start time for a deployment still running`, async () => {
    const probe = statusContext(c.configTypeId, { latest: deploymentSummary({ completedAt: null }) })
    const status = await c.handler(probe.ctx)

    assert.equal(status.deployed, true)
    assert.equal(status.lastDeployedAt, '2026-01-01T09:00:00.000Z')
  })

  test(`${c.label} getStatus: survives a platform lookup that fails, reporting not deployed`, async () => {
    // Status is best-effort. A rejected lookup must not surface as a pipeline
    // crash — but it must also not be reported as a successful deployment.
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.configTypeId, { lookupFails: true })
      const status = await c.handler(probe.ctx)

      assert.equal(status.deployed, false)
      assert.equal(status.lastDeployedAt, '')
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: reports no component status when no tenant is registered`, async () => {
    const probe = statusContext(c.configTypeId, { latest: deploymentSummary(), component: null })
    const status = await c.handler(probe.ctx)

    assert.equal(status.deployed, true)
    assert.deepEqual(status.componentStatuses, [])
  })
}

// --- deploy: the pre-flight refusals ------------------------------------------

export interface DeployGuardContract {
  label: string
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /** A canvas the config type would otherwise deploy. */
  items: CanvasItemSnapshot[]
  /** The first collection the deploy reads — the read that must fail closed. */
  listPath: string
  /** Extra collections the deploy reads; registered FIRST so they are never shadowed. */
  extraRoutes?: Route[]
  /**
   * Set for a SINGLETON config type, which has no listing: it reads one object
   * and writes it back, so "an empty canvas writes nothing" does not apply.
   */
  singleton?: boolean
  /**
   * Set ONLY where the handler does not fail closed on an unreadable target, to
   * leave that path unasserted rather than assert the broken behaviour. Every
   * use of this flag is a defect in the report accompanying these tests, not a
   * property of the config type — do not add one to make a suite green.
   */
  skipFailedReadGuards?: boolean
}

/**
 * Register the refusals every Netskope deploy shares. The value of each is the
 * zero-call assertion: a handler that returns `success: false` AFTER writing
 * half a policy set has still changed the customer's tenant.
 */
export function registerDeployGuardContract(c: DeployGuardContract): void {
  const listRe = pathRe(c.listPath)
  const extra = c.extraRoutes ?? []

  test(`${c.label} deploy: refuses without a credential, without calling Netskope`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(c.items, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Netskope without a credential')
      assert.match(String(result.message), /No usable Netskope credential/)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses a credential carrying no token, without calling Netskope`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(c.items, { credential: EMPTY_CREDENTIAL }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Netskope with an unusable credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses when no tenant host is configured, without calling Netskope`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(c.items, { settings: settingsWithoutTenant() }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Netskope without a tenant host')
    } finally {
      restore()
    }
  })

  if (!c.skipFailedReadGuards) {
    test(`${c.label} deploy: a rejected read fails the deploy without writing anything`, async () => {
      // The tenant refused the credential. Proceeding would create duplicates of
      // everything the handler could not see.
      const { calls, restore } = routeFetch([...extra, { url: listRe, method: 'GET', respond: forbidden() }])
      try {
        const result = await c.handler(deployContext(c.items))

        assert.equal(result.success, false)
        assert.equal(
          writeCalls(calls).length,
          0,
          `nothing may be written when the tenant could not be read: ${writeCalls(calls)
            .map((x) => `${x.method} ${x.url}`)
            .join(', ')}`,
        )
        assert.equal(leaksToken(result), false, 'the failure message must not echo the API token')
      } finally {
        restore()
      }
    })

    test(`${c.label} deploy: an unreadable tenant fails the deploy without writing anything`, async () => {
      // A 500 is "I could not look", which must never become "the tenant is
      // empty, create everything".
      const { calls, restore } = routeFetch([...extra, { url: listRe, method: 'GET', respond: serverError() }])
      try {
        const result = await c.handler(deployContext(c.items))

        assert.equal(result.success, false)
        assert.match(String(result.message), /Internal server error/)
        assert.equal(writeCalls(calls).length, 0)
        assert.equal(leaksToken(result), false)
      } finally {
        restore()
      }
    })
  }

  if (!c.singleton) {
    test(`${c.label} deploy: an empty canvas writes nothing`, async () => {
      const { calls, restore } = routeFetch([...extra, { url: listRe, method: 'GET', respond: list([]) }])
      try {
        const result = await c.handler(deployContext([]))

        assert.equal(result.success, true)
        assert.equal(
          writeCalls(calls).length,
          0,
          `an empty canvas must not write: ${writeCalls(calls)
            .map((x) => `${x.method} ${x.url}`)
            .join(', ')}`,
        )
      } finally {
        restore()
      }
    })
  }
}

// --- deploy: the create / update / record contract ----------------------------

export interface CrudDeployContract {
  label: string
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /** Collection path, e.g. '/rbac/labels'. */
  basePath: string
  /** Present for an NPA-enveloped listing; absent for a bare JSON array. */
  listKey?: string
  /** How the CREATE response is shaped. */
  createEnvelope: 'npa' | 'bare'
  /** The verb an update uses against `${basePath}/${id}`. */
  updateMethod: 'PUT' | 'PATCH'
  /** Build one canvas item declaring the object. */
  item: (name: string) => CanvasItemSnapshot
  /** The object as the TENANT holds it — deliberately different from `item`. */
  live: (name: string, id: string) => Record<string, unknown>
  /** The body the create call returns, carrying the new id. */
  createdBody: (name: string, id: string) => Record<string, unknown>
  /** The id the create response carries. */
  newId?: string
  /** The id the live object carries. */
  liveId?: string
  /** Key the rollback entry stores its identity under — `name`, or `site` for tunnels. */
  nameKey?: string
  /** Extra collections the deploy reads before writing — registered FIRST. */
  extraRoutes?: Route[]
  /** Writes that are not the resource itself (e.g. the URL-list apply POST). */
  ignoreWrites?: RegExp
  /** Assert the prior snapshot deploy recorded is the LIVE state, not the canvas. */
  assertPrior: (prior: Record<string, unknown>) => void
  /** Assert the create body carries what the canvas declared. */
  assertCreateBody?: (body: Record<string, unknown>) => void
}

interface Entry {
  name?: string
  site?: string
  existed?: boolean
  id?: string
  prior?: Record<string, unknown>
}

function entriesOf(result: DeployResult): Entry[] {
  const data = result.rollbackData as { entries?: Entry[] } | undefined
  return Array.isArray(data?.entries) ? (data.entries as Entry[]) : []
}

/**
 * Register the create / update / record contract shared by the 20
 * collection-backed configuration types.
 *
 * The load-bearing assertions are the update path — the one that silently
 * overwrites a live object — and the prior state it records. The live fixture is
 * deliberately different from the canvas so a handler that recorded the DESIRED
 * values instead of the LIVE ones fails here rather than in production, where the
 * only symptom is a rollback that restores the thing it was undoing.
 */
export function registerCrudDeployContract(c: CrudDeployContract): void {
  const newId = c.newId ?? '9001'
  const liveId = c.liveId ?? '4102'
  const nameKey = c.nameKey ?? 'name'
  const extra = c.extraRoutes ?? []
  const listRe = pathRe(c.basePath)
  const ignore = c.ignoreWrites

  const resourceWrites = (calls: Parameters<typeof writeCalls>[0]) =>
    writeCalls(calls).filter((call) => !ignore || !ignore.test(call.url))

  const listing = (items: unknown[]): CannedResponse => (c.listKey ? npaList(c.listKey, items) : list(items))
  const createResponse = (name: string, id: string): CannedResponse =>
    c.createEnvelope === 'npa' ? npaData(c.createdBody(name, id)) : created(c.createdBody(name, id))

  test(`${c.label} deploy: creates an object the tenant does not have`, async () => {
    const { calls, restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([]) },
      { url: listRe, method: 'POST', respond: createResponse('veltrix-alpha', newId) },
    ])
    try {
      const result = await c.handler(deployContext([c.item('veltrix-alpha')]))

      assert.equal(result.success, true, `deploy failed: ${result.message}`)
      assertTokenSent(assert, calls)

      const writes = resourceWrites(calls)
      assert.equal(writes.length, 1, `expected one write, got ${writes.map((x) => `${x.method} ${x.url}`).join(', ')}`)
      assert.equal(writes[0].method, 'POST')
      assert.equal(writes[0].url, `${BASE_URL}${c.basePath}`, 'a create posts to the collection, not to an id')
      if (c.assertCreateBody) c.assertCreateBody(bodyOf(writes[0]) ?? {})

      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'deploy must record what it created')
      assert.equal(entries[0][nameKey as 'name'], 'veltrix-alpha')
      assert.equal(entries[0].existed, false, 'a created object is recorded as not pre-existing')
      assert.equal(entries[0].id, newId, 'the created id is what rollback deletes')
      assert.equal(leaksToken(result), false, 'rollbackData must not carry the API token')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: updates the object that already exists instead of creating a second`, async () => {
    const { calls, restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([c.live('veltrix-alpha', liveId)]) },
      { url: listRe, method: c.updateMethod, respond: ok({ id: liveId }) },
    ])
    try {
      const result = await c.handler(deployContext([c.item('veltrix-alpha')]))

      assert.equal(result.success, true, `deploy failed: ${result.message}`)
      const writes = resourceWrites(calls)
      assert.equal(
        writes.filter((x) => x.method === 'POST').length,
        0,
        'an object that already exists must be updated, never created a second time',
      )
      assert.equal(writes.length, 1, `expected one write, got ${writes.map((x) => `${x.method} ${x.url}`).join(', ')}`)
      assert.equal(writes[0].method, c.updateMethod)
      assert.equal(writes[0].url, `${BASE_URL}${c.basePath}/${liveId}`)

      const entries = entriesOf(result)
      assert.equal(entries.length, 1)
      assert.equal(entries[0].existed, true, 'an updated object is recorded as pre-existing')
      assert.equal(entries[0].id, liveId)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: records the LIVE prior state, not the values it is about to write`, async () => {
    const { restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([c.live('veltrix-alpha', liveId)]) },
      { url: listRe, method: c.updateMethod, respond: ok({ id: liveId }) },
    ])
    try {
      const result = await c.handler(deployContext([c.item('veltrix-alpha')]))

      const entries = entriesOf(result)
      assert.equal(entries.length, 1)
      assert.ok(entries[0].prior, 'an update must record the prior state or it cannot be undone')
      c.assertPrior(entries[0].prior as Record<string, unknown>)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: matches the live object by the id a previous deploy recorded, surviving a rename`, async () => {
    // The object was renamed in the tenant. Name matching would miss it and
    // create a duplicate; the recorded id is what keeps the update an update.
    const { calls, restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([c.live('renamed-in-tenant', liveId)]) },
      { url: listRe, method: c.updateMethod, respond: ok({ id: liveId }) },
    ])
    try {
      const declared = c.item('veltrix-alpha')
      const result = await c.handler(
        deployContext([{ ...declared, id: 'canvas-item-1' }], {
          latestDeployment: priorDeployment([
            { itemId: 'canvas-item-1', [nameKey]: 'veltrix-alpha', existed: true, id: liveId },
          ]),
        }),
      )

      assert.equal(result.success, true, `deploy failed: ${result.message}`)
      const writes = resourceWrites(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].method, c.updateMethod)
      assert.equal(writes[0].url, `${BASE_URL}${c.basePath}/${liveId}`)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: records what it created even when the create response carried no id`, async () => {
    // The object now exists in the tenant. Recording nothing at all would lose it
    // entirely; the entry is what tells an operator something was created.
    const { restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([]) },
      { url: listRe, method: 'POST', respond: created({}) },
    ])
    try {
      const result = await c.handler(deployContext([c.item('veltrix-alpha')]))

      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'a successful create must be recorded whether or not an id came back')
      assert.equal(entries[0][nameKey as 'name'], 'veltrix-alpha')
      assert.equal(entries[0].existed, false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: reports a rejected write instead of throwing, and keeps what it already recorded`, async () => {
    // The first object is created, the second is rejected. A catch that returned
    // only a message would discard the first entry and orphan the created object.
    const { calls, restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([]) },
      {
        url: listRe,
        method: 'POST',
        respond: [createResponse('veltrix-alpha', newId), badRequest('name already in use')],
      },
    ])
    try {
      const result = await c.handler(deployContext([c.item('veltrix-alpha'), c.item('veltrix-beta')]))

      assert.equal(result.success, false)
      assert.match(String(result.message), /veltrix-beta/)
      assert.match(String(result.message), /name already in use/)

      const entries = entriesOf(result)
      assert.equal(entries.length, 1, 'the object that WAS created must still be recoverable')
      assert.equal(entries[0][nameKey as 'name'], 'veltrix-alpha')
      assert.equal(entries[0].id, newId)
      assert.equal(leaksToken(result), false)
      assert.equal(resourceWrites(calls).length, 2, 'both writes were attempted; only one succeeded')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: deploys anyway when the platform cannot supply the previous deployment`, async () => {
    // The prior-entry lookup is an optimisation for rename matching. A platform
    // outage must not take the deploy down with it.
    const { restore } = routeFetch([
      ...extra,
      { url: listRe, method: 'GET', respond: listing([]) },
      { url: listRe, method: 'POST', respond: createResponse('veltrix-alpha', newId) },
    ])
    try {
      const result = await c.handler(deployContext([c.item('veltrix-alpha')], { deploymentLookupFails: true }))

      assert.equal(result.success, true, `deploy failed: ${result.message}`)
      assert.equal(entriesOf(result).length, 1)
    } finally {
      restore()
    }
  })
}

// --- rollback -----------------------------------------------------------------

export interface RollbackGuardContract {
  label: string
  handler: (ctx: RollbackContext) => Promise<RollbackResult>
  /** Key a rollback entry stores its identity under — `name` for most, `site` for tunnels. */
  nameKey?: string
}

/**
 * Register the rollback refusals every Netskope configuration type shares.
 *
 * The two that matter are the last two: an entry recording an object that was
 * CREATED but whose id was never captured, and an entry recording an object that
 * was UPDATED but whose prior body was never captured. Neither can be undone, and
 * the only safe response is to touch nothing — a rollback that invents a body is
 * how a hand-tuned production rule gets replaced with a default.
 */
export function registerRollbackGuardContract(c: RollbackGuardContract): void {
  const nameKey = c.nameKey ?? 'name'
  const entry = (over: Record<string, unknown>) => ({ [nameKey]: 'veltrix-alpha', ...over })

  test(`${c.label} rollback: refuses without a credential, without calling Netskope`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(
        rollbackContext({ entries: [entry({ existed: false, id: '42' })] }, { credential: null }),
      )

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Netskope without a credential')
      assert.match(String(result.message), /No usable Netskope credential/)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: refuses when no tenant host is configured, without calling Netskope`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(
        rollbackContext({ entries: [entry({ existed: false, id: '42' })] }, { settings: settingsWithoutTenant() }),
      )

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'the tenant is unaddressable without a host')
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: calls nothing when deploy recorded nothing`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      await c.handler(rollbackContext(undefined))

      assert.equal(calls.length, 0, 'nothing recorded means nothing to call')
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: calls nothing for an empty recording`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      await c.handler(rollbackContext({ entries: [] }))

      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: makes no call for a created entry whose id was never captured`, async () => {
    // Deploy created the object but never recorded its id. There is no safe
    // DELETE to issue, and guessing one would delete somebody else's object.
    const { calls, restore } = routeFetch([], ok())
    try {
      await c.handler(rollbackContext({ entries: [entry({ existed: false })] }))

      assert.equal(calls.length, 0, `expected no call, got ${calls.map((x) => `${x.method} ${x.url}`).join(', ')}`)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: writes nothing for an updated entry whose prior state was never captured`, async () => {
    // Deploy overwrote a live object but recorded no prior body. Restoring an
    // invented default here is strictly worse than leaving the object alone.
    const { calls, restore } = routeFetch([], ok())
    try {
      await c.handler(rollbackContext({ entries: [entry({ existed: true, id: '42' })] }))

      assert.equal(
        writeCalls(calls).length,
        0,
        `expected no write, got ${writeCalls(calls)
          .map((x) => `${x.method} ${x.url}`)
          .join(', ')}`,
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: ignores a malformed recording rather than throwing`, async () => {
    const { calls, restore } = routeFetch([], ok())
    try {
      const result = await c.handler(rollbackContext({ entries: 'not-an-array' }))

      assert.equal(typeof result.success, 'boolean')
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })
}

export interface CrudRollbackContract {
  label: string
  handler: (ctx: RollbackContext) => Promise<RollbackResult>
  basePath: string
  updateMethod: 'PUT' | 'PATCH'
  nameKey?: string
  /** A prior snapshot exactly as deploy would have recorded it. */
  prior: Record<string, unknown>
  /** Assert the restore body is the recorded prior. */
  assertRestoreBody: (body: Record<string, unknown>) => void
  /** Writes that are not the resource itself (e.g. the URL-list apply POST). */
  ignoreWrites?: RegExp
  /** Routes the revert needs besides the resource itself — registered FIRST. */
  extraRoutes?: Route[]
}

/** Register the restore / delete contract shared by the collection-backed types. */
export function registerCrudRollbackContract(c: CrudRollbackContract): void {
  const nameKey = c.nameKey ?? 'name'
  const listRe = pathRe(c.basePath)
  const ignore = c.ignoreWrites
  const extra = c.extraRoutes ?? []
  const resourceWrites = (calls: Parameters<typeof writeCalls>[0]) =>
    writeCalls(calls).filter((call) => !ignore || !ignore.test(call.url))

  const updated = { [nameKey]: 'veltrix-alpha', existed: true, id: '4102', prior: c.prior }
  const createdEntry = { [nameKey]: 'veltrix-beta', existed: false, id: '9001' }

  test(`${c.label} rollback: restores the prior state of an object deploy overwrote`, async () => {
    const { calls, restore } = routeFetch([
      ...extra,
      { url: listRe, method: c.updateMethod, respond: ok({ id: '4102' }) },
    ])
    try {
      const result = await c.handler(rollbackContext({ entries: [updated] }))

      assert.equal(result.success, true, `rollback failed: ${result.message}`)
      assertTokenSent(assert, calls)
      const writes = resourceWrites(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].method, c.updateMethod)
      assert.equal(writes[0].url, `${BASE_URL}${c.basePath}/4102`)
      c.assertRestoreBody(bodyOf(writes[0]) ?? {})
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: deletes an object deploy created`, async () => {
    const { calls, restore } = routeFetch([...extra, { url: listRe, method: 'DELETE', respond: NO_CONTENT }])
    try {
      const result = await c.handler(rollbackContext({ entries: [createdEntry] }))

      assert.equal(result.success, true, `rollback failed: ${result.message}`)
      const writes = resourceWrites(calls)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].method, 'DELETE')
      assert.equal(writes[0].url, `${BASE_URL}${c.basePath}/9001`)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: treats an object that is already gone as nothing to undo`, async () => {
    const { restore } = routeFetch(extra, notFound())
    try {
      const result = await c.handler(rollbackContext({ entries: [updated, createdEntry] }))

      assert.equal(result.success, true, '404 is a known answer — the object is already in the wanted state')
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: reports a rejected restore instead of throwing`, async () => {
    const { restore } = routeFetch(extra, netskopeError(500, 'Internal server error'))
    try {
      const result = await c.handler(rollbackContext({ entries: [updated] }))

      assert.equal(result.success, false)
      assert.match(String(result.message), /Internal server error/)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })
}

// --- driftDetect --------------------------------------------------------------

export interface DriftContract {
  label: string
  handler: (ctx: DriftContext) => Promise<DriftResult>
  /** Collection path the drift read hits. */
  basePath: string
  /** Present for an NPA-enveloped listing; absent for a bare JSON array. */
  listKey?: string
  /** One declared object, exactly as the deployed canvas stored it. */
  items: CanvasItemSnapshot[]
  /** The live listing that matches `items` exactly — no drift. */
  inSync: unknown[]
  /** The identity the "missing" diff is reported under (name or site). */
  missingField: string
}

/**
 * Register the drift-detection contract every Netskope configuration type shares.
 *
 * The load-bearing ones are the failed reads: a listing that answered 500 means
 * "I could not look", and a handler that lets that become an empty list reports
 * every managed object as deleted. `checked: false` is the contract for saying so.
 */
export function registerDriftContract(c: DriftContract): void {
  const listRe = pathRe(c.basePath)
  const listing = (items: unknown[]): CannedResponse => (c.listKey ? npaList(c.listKey, items) : list(items))

  test(`${c.label} driftDetect: makes no call without a credential, and says it did not check`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext(c.items, { credential: null }))

      assert.equal(calls.length, 0, 'must not reach Netskope without a credential')
      assert.equal(result.checked, false, 'a handler that could not look must not claim it found nothing')
      assert.equal(result.hasDrift, false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: makes no call without a tenant host, and says it did not check`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext(c.items, { settings: settingsWithoutTenant() }))

      assert.equal(calls.length, 0)
      assert.equal(result.checked, false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports no drift when the tenant matches what was deployed`, async () => {
    const { calls, restore } = routeFetch([{ url: listRe, method: 'GET', respond: listing(c.inSync) }])
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
      assert.deepEqual(result.diffs, [])
      assert.notEqual(result.checked, false, 'it did look, so it must not report itself as unchecked')
      assert.equal(writeCalls(calls).length, 0, 'drift must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a declared object that no longer exists as critical drift`, async () => {
    const { calls, restore } = routeFetch([{ url: listRe, method: 'GET', respond: listing([]) }])
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(result.hasDrift, true, 'an object deleted in the tenant is drift')
      assert.ok(
        result.diffs.some((d) => d.field === c.missingField && d.actual === 'absent' && d.severity === 'critical'),
        `expected a critical "absent" diff for ${c.missingField}, got ${JSON.stringify(result.diffs)}`,
      )
      assert.equal(writeCalls(calls).length, 0, 'drift must never write')
      assert.equal(leaksToken(result), false, 'a diff must not carry the API token')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: an unreadable tenant is reported as unchecked, never as the objects being gone`, async () => {
    // The tenant answered 500. That is "I could not look", not "there are none",
    // and turning it into `actual: 'absent'` tells an operator their production
    // configuration was deleted. A bare `hasDrift: false` is just as wrong: the
    // platform reads that as a positive all-clear and resolves real drift records.
    const { calls, restore } = routeFetch([], serverError())
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(
        result.diffs.some((d) => d.actual === 'absent'),
        false,
        `a 500 became "absent": ${JSON.stringify(result.diffs)}`,
      )
      assert.equal(result.checked, false, 'an unreadable tenant must carry checked: false')
      assert.equal(result.hasDrift, false)
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: a rejected token is reported as unchecked, not as the objects being gone`, async () => {
    const { calls, restore } = routeFetch([], forbidden())
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(
        result.diffs.some((d) => d.actual === 'absent'),
        false,
        'a 403 must not read as the objects being gone',
      )
      assert.equal(result.checked, false)
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports nothing and writes nothing when nothing is declared`, async () => {
    const { calls, restore } = routeFetch([{ url: listRe, method: 'GET', respond: listing([]) }])
    try {
      const result = await c.handler(driftContext([]))

      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })
}
