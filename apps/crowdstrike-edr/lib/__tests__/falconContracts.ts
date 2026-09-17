// =============================================================================
// Reusable handler contracts for the crowdstrike-edr app, built on fakeFalcon.
//
// Four of this app's six handlers are uniform across all 44 configuration types
// once you strip the resource name out of them:
//
//   getStatus    — IDENTICAL in every config type (only its doc comment differs):
//                  it reads the platform's own deployment + `falcon-tenant`
//                  component records and never touches Falcon.
//   healthCheck  — the same three steps everywhere: build the client, fail
//                  closed if the credential is unusable, probe ONE endpoint,
//                  then confirm each declared object exists.
//   deploy       — the same pre-flight refusal before the first request.
//   rollback     — the same refusals: no credential, and nothing recorded.
//   driftDetect  — the same rules: drift never writes, an empty deployed config
//                  needs no read, and a failed read never becomes "missing".
//
// Writing 44 hand-copied variants of each would be 44 places for the assertion
// to drift. These register the shared contract; a config type's own test file
// calls it and adds what is specific to itself — above all deploy's
// create/update paths and the rollback state they record, which are
// per-resource and live there.
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
  CannedResponse,
  EMPTY,
  TOKEN,
  assertAuthenticatedFirst,
  component,
  credentialWithoutClientId,
  deployContext,
  deploymentSummary,
  describeCalls,
  driftContext,
  emptyCredential,
  forbidden,
  healthContext,
  leaksSecret,
  recordFetch,
  rollbackContext,
  routeFetch,
  serverError,
  statusContext,
  tokenError,
  unauthorized,
  vendorCalls,
  writeCalls,
} from './fakeFalcon'

/**
 * `MISSING_CREDENTIAL_MESSAGE` from `lib/falcon.ts`, as every handler surfaces
 * it verbatim. Matched loosely so a wording change does not break 44 files.
 */
const CREDENTIAL_REFUSAL = /No Falcon API client available/

// --- healthCheck --------------------------------------------------------------

export interface HealthCheckContract {
  /** The configuration type's id, used only in test titles. */
  label: string
  handler: (ctx: HealthCheckContext) => Promise<HealthCheckResult>
  /** A substring of the path the reachability probe must hit. */
  probePath: string
  /**
   * What the probe endpoint returns when the tenant is reachable. Defaults to an
   * empty `{ meta, resources }` envelope, which is what every probe in this app
   * asks for (`limit: 1`).
   */
  probeResponse?: CannedResponse
  /** A fragment of the message the 403 branch reports — the missing API scope. */
  scopePattern?: RegExp
}

/** Register the health-check contract every crowdstrike-edr config type shares. */
export function registerHealthCheckContract(c: HealthCheckContract): void {
  const probe = c.probeResponse ?? EMPTY

  test(`${c.label} healthCheck: refuses without a credential, without calling Falcon`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Falcon without a credential')
      const check = result.checks.find((x) => x.name === 'falcon_credential')
      assert.ok(
        check,
        `expected a "falcon_credential" check, got ${result.checks.map((x) => x.name).join(', ')}`,
      )
      assert.equal(check.passed, false)
      assert.match(String(check.message), CREDENTIAL_REFUSAL)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses a credential with no secret, without calling Falcon`, async () => {
    // A credential row exists but its secret fields are blank — OAuth2
    // client-credentials has nothing to present, so there is nothing to try.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: emptyCredential() }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Falcon with an unusable credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses a credential with no client id, without calling Falcon`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: credentialWithoutClientId() }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Falcon without a client id')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: authenticates before probing, and reports healthy`, async () => {
    const { calls, restore } = recordFetch([TOKEN, probe])
    try {
      const result = await c.handler(healthContext([]))

      const tenantCalls = assertAuthenticatedFirst(assert, calls)
      assert.equal(tenantCalls.length, 1, 'an empty canvas needs exactly one reachability probe')
      assert.equal(tenantCalls[0].method, 'GET')
      assert.ok(
        tenantCalls[0].url.includes(c.probePath),
        `probe hit ${tenantCalls[0].url}, expected it to include ${c.probePath}`,
      )
      assert.equal(result.healthy, true)
      // The SDK contract: score is a PERCENTAGE, not a fraction.
      assert.equal(result.score, 100)

      const check = result.checks.find((x) => x.name === 'falcon_reachable')
      assert.ok(
        check,
        `expected a "falcon_reachable" check, got ${result.checks.map((x) => x.name).join(', ')}`,
      )
      assert.equal(check.passed, true)
      assert.equal(typeof check.latencyMs, 'number')
      assert.equal(leaksSecret(result), false, 'health result must not carry the token or client secret')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports a rejected bearer token rather than throwing`, async () => {
    // FalconClient treats a 401 as an expired cached token and replays the
    // request after re-authenticating, so this needs URL routing, not a queue.
    const { calls, restore } = routeFetch([], unauthorized())
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === 'falcon_reachable')
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /401/)
      assert.equal(leaksSecret(result), false)
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports a missing API scope rather than throwing`, async () => {
    const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], forbidden())
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === 'falcon_reachable')
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), c.scopePattern ?? /403/)
      assert.equal(leaksSecret(result), false)
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: surfaces the vendor's error rather than throwing`, async () => {
    const { calls, restore } = routeFetch(
      [{ url: /oauth2\/token/, respond: TOKEN }],
      serverError('internal server error'),
    )
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === 'falcon_reachable')
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /internal server error/)
      assert.equal(leaksSecret(result), false)
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: a rejected token exchange is reported, not thrown`, async () => {
    const { calls, restore } = recordFetch([tokenError()])
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(vendorCalls(calls).length, 0, 'no tenant call may follow a failed token exchange')
      assert.equal(leaksSecret(result), false, 'the failure message must not echo the client secret')
    } finally {
      restore()
    }
  })
}

// --- deploy: the pre-flight refusals ------------------------------------------

export interface DeployGuardContract {
  label: string
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /**
   * A canvas the config type would otherwise deploy. Every assertion here is
   * about refusing BEFORE the canvas matters, so an empty canvas is fine — pass
   * items to prove the refusal survives real work being requested.
   */
  items?: CanvasItemSnapshot[]
}

/**
 * Register the refusals every crowdstrike-edr deploy shares. The value of each
 * is the zero-call assertion: a handler that returns `success: false` AFTER
 * writing half a policy set has still changed the customer's tenant.
 */
export function registerDeployGuardContract(c: DeployGuardContract): void {
  const items = c.items ?? []

  test(`${c.label} deploy: refuses without a credential, without calling Falcon`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(items, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Falcon without a credential')
      assert.match(String(result.message), CREDENTIAL_REFUSAL)
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses a credential with no secret, without calling Falcon`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(items, { credential: emptyCredential() }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Falcon with an unusable credential')
      assert.match(String(result.message), CREDENTIAL_REFUSAL)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses a credential with no client id, without calling Falcon`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(items, { credential: credentialWithoutClientId() }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Falcon without a client id')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a rejected token exchange fails the deploy without writing`, async () => {
    const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: tokenError() }])
    try {
      const result = await c.handler(deployContext(items))

      assert.equal(result.success, false)
      assert.equal(writeCalls(calls).length, 0, 'nothing may be written when authentication failed')
      assert.equal(leaksSecret(result), false, 'the failure message must not echo the client secret')
    } finally {
      restore()
    }
  })
}

// --- rollback -----------------------------------------------------------------

export interface RollbackGuardContract {
  label: string
  handler: (ctx: RollbackContext) => Promise<RollbackResult>
  /**
   * One entry as deploy would have recorded it, complete enough that the handler
   * would act on it. Used only to prove the credential refusal fires FIRST.
   */
  entry: Record<string, unknown>
}

/**
 * Register the rollback refusals every crowdstrike-edr configuration type
 * shares. All 44 store their state as `{ previousState: [...] }` and all 44
 * report the same message when there is none.
 *
 * The per-entry refusals — an entry recording a CREATED object whose id was
 * never captured, and an UPDATED object whose prior body was never captured —
 * are NOT here: the branches differ per config type (some re-resolve by name,
 * some require the recorded id), so each config type asserts its own.
 */
export function registerRollbackGuardContract(c: RollbackGuardContract): void {
  test(`${c.label} rollback: refuses without a credential, without calling Falcon`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(
        rollbackContext({ previousState: [c.entry] }, { credential: null }),
      )

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Falcon without a credential')
      assert.match(String(result.message), CREDENTIAL_REFUSAL)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: reports there is nothing to undo when deploy recorded nothing`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(rollbackContext(undefined))

      assert.equal(result.success, false)
      assert.match(String(result.message), /No previous state available for rollback/)
      assert.equal(calls.length, 0, 'nothing recorded means nothing to call')
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: reports there is nothing to undo for an empty recording`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(rollbackContext({ previousState: [] }))

      assert.equal(result.success, false)
      assert.match(String(result.message), /No previous state available for rollback/)
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: reports there is nothing to undo when rollbackData is the wrong shape`, async () => {
    // A deploy that failed before it recorded anything can leave the platform
    // holding a value this handler cannot read. It must refuse, not throw.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(rollbackContext({ notPreviousState: 'whatever' }))

      assert.equal(result.success, false)
      assert.match(String(result.message), /No previous state available for rollback/)
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: reports a rejected token exchange rather than throwing`, async () => {
    const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: tokenError() }])
    try {
      const result = await c.handler(rollbackContext({ previousState: [c.entry] }))

      assert.equal(result.success, false)
      assert.equal(writeCalls(calls).length, 0, 'nothing may be written when authentication failed')
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })
}

// --- driftDetect --------------------------------------------------------------

export interface DriftContract {
  label: string
  handler: (ctx: DriftContext) => Promise<DriftResult>
  /** One declared object, exactly as the deployed canvas stored it. */
  items: CanvasItemSnapshot[]
  /**
   * A response that makes every declared object read as ABSENT. Defaults to an
   * empty envelope, which is what an id query with no match answers with.
   */
  absentResponse?: CannedResponse
  /**
   * The `actual` value a diff carries when the declared object is gone. Nearly
   * every config type words it `'missing'`, but a few word it for their own
   * resource — `'not registered'` for a cloud account registration, `'no
   * mapping'` for an MSSP role mapping. The assertion is the same either way:
   * absence is CRITICAL drift, and a FAILED READ must never produce this marker.
   */
  absentActual?: string
}

/**
 * Register the drift contract every crowdstrike-edr configuration type shares.
 *
 * The load-bearing one is the last: a read that answered 500 means "I could not
 * look", and a handler that lets that become an empty list reports every managed
 * object as deleted. That is the defect this catalog has hit most often.
 */
export function registerDriftContract(c: DriftContract): void {
  const absent = c.absentResponse ?? EMPTY
  const absentActual = c.absentActual ?? 'missing'

  test(`${c.label} driftDetect: never writes`, async () => {
    // Everything absent — the branch that produces the most diffs — must still
    // produce no change to the tenant.
    const { calls, restore } = routeFetch([], absent)
    try {
      await c.handler(driftContext(c.items))

      assert.equal(writeCalls(calls).length, 0, `drift wrote: ${describeCalls(writeCalls(calls))}`)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: makes no call without a credential`, async () => {
    // NOTE: what this handler RETURNS on this path is deliberately NOT asserted.
    // It returns a bare `hasDrift: false, diffs: []`, which the platform reads as
    // a positive "I checked and found nothing" and uses to resolve outstanding
    // drift records. It wants `checked: false` — see the accompanying report.
    // Asserting the current return here would bless that.
    const { calls, restore } = recordFetch([])
    try {
      await c.handler(driftContext(c.items, { credential: null }))

      assert.equal(calls.length, 0, 'must not reach Falcon without a credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports nothing and calls nothing when nothing is declared`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext([]))

      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
      assert.equal(calls.length, 0, 'an empty deployed config needs no tenant read')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a declared object that no longer exists as critical drift`, async () => {
    const { calls, restore } = routeFetch([], absent)
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(result.hasDrift, true, 'an object deleted in the tenant is drift')
      assert.ok(
        result.diffs.some((d) => d.actual === absentActual && d.severity === 'critical'),
        `expected a critical "${absentActual}" diff, got ${JSON.stringify(result.diffs)}`,
      )
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksSecret(result), false, 'a diff must not carry the token or client secret')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: a failed read is never reported as the object being gone`, async () => {
    // The tenant answered 500. That is "I could not look", not "there is none",
    // and turning it into `actual: 'missing'` tells an operator their production
    // configuration was deleted.
    const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: TOKEN }], serverError())
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(
        result.diffs.some((d) => d.actual === absentActual),
        false,
        `a 500 became "${absentActual}": ${JSON.stringify(result.diffs)}`,
      )
      assert.ok(
        result.hasDrift === true || result.checked === false,
        'an unreadable tenant must not come back as a bare, positive "no drift"',
      )
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: a rejected token exchange is reported, not thrown`, async () => {
    const { calls, restore } = routeFetch([{ url: /oauth2\/token/, respond: tokenError() }])
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(
        result.diffs.some((d) => d.actual === absentActual),
        false,
        'a failed token exchange must not read as the object being gone',
      )
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksSecret(result), false)
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
 * Register the getStatus contract every crowdstrike-edr configuration type
 * shares — it is identical in all 44.
 */
export function registerGetStatusContract(c: GetStatusContract): void {
  test(`${c.label} getStatus: reports not deployed when no successful deployment exists`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.configTypeId, { latest: null })
      const status = await c.handler(probe.ctx)

      assert.equal(status.deployed, false)
      assert.equal(status.lastDeployedAt, '')
      assert.deepEqual(status.componentStatuses, [])
      assert.equal(calls.length, 0, 'getStatus reads platform records only — it must not call Falcon')
      assert.deepEqual(probe.deploymentQueries, [{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
      assert.deepEqual(probe.componentQueries, [], 'no components need listing when nothing is deployed')
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
      assert.equal(status.componentStatuses[0].deployed, true)
      assert.equal(status.componentStatuses[0].version, '11')
      assert.equal(status.componentStatuses[0].lastDeployedAt, '2026-01-01T09:05:00.000Z')
      assert.deepEqual(probe.componentQueries, [{ types: ['falcon-tenant'] }])
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
    assert.equal(
      status.componentStatuses[0].lastDeployedAt,
      '',
      'a per-component time is only reported once the deployment completed',
    )
  })

  test(`${c.label} getStatus: carries the recorded health score through, and its 80 threshold`, async () => {
    const healthy = await c.handler(
      statusContext(c.configTypeId, { latest: deploymentSummary({ healthScore: 80 }) }).ctx,
    )
    assert.equal(healthy.componentStatuses[0].healthScore, 80)
    assert.equal(healthy.componentStatuses[0].healthy, true)

    const degraded = await c.handler(
      statusContext(c.configTypeId, { latest: deploymentSummary({ healthScore: 79 }) }).ctx,
    )
    assert.equal(degraded.componentStatuses[0].healthScore, 79)
    assert.equal(degraded.componentStatuses[0].healthy, false)

    const unknown = await c.handler(
      statusContext(c.configTypeId, { latest: deploymentSummary({ healthScore: null }) }).ctx,
    )
    assert.equal(unknown.componentStatuses[0].healthScore, undefined)
    assert.equal(
      unknown.componentStatuses[0].healthy,
      undefined,
      'no recorded score means unknown, not unhealthy',
    )
  })

  test(`${c.label} getStatus: reports every registered tenant, and none when there are none`, async () => {
    const two = statusContext(c.configTypeId, {
      latest: deploymentSummary(),
      components: [
        component({ id: 'comp-1', hostname: 'api.crowdstrike.com' }),
        component({ id: 'comp-2', hostname: 'api.eu-1.crowdstrike.com' }),
      ],
    })
    const status = await c.handler(two.ctx)
    assert.deepEqual(
      status.componentStatuses.map((s) => s.hostname),
      ['api.crowdstrike.com', 'api.eu-1.crowdstrike.com'],
    )

    const none = statusContext(c.configTypeId, { latest: deploymentSummary(), components: [] })
    const empty = await c.handler(none.ctx)
    assert.equal(empty.deployed, true)
    assert.deepEqual(empty.componentStatuses, [])
  })
}
