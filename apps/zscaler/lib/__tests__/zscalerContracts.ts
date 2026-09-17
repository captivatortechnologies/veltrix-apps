// =============================================================================
// Reusable handler contracts for the Zscaler app, built on fakeZscaler.
//
// Four of this app's six handlers are uniform across all 33 configuration types
// once you strip the resource name out of them:
//
//   getStatus    — byte-identical in every config type: it reads the platform's
//                  own deployment + component records and never touches Zscaler.
//   healthCheck  — the same four steps everywhere: build the client, fail closed
//                  if the credential (or, on ZPA, the customer id) is unusable,
//                  probe ONE endpoint, then confirm each declared object exists.
//   deploy       — the same pre-flight refusals before the first request.
//   rollback     — the same refusals, plus the rule that an entry with nothing
//                  recorded must make no call rather than write an invented value.
//   driftDetect  — the same rule that drift never writes and never turns a failed
//                  read into "these objects are missing".
//
// Writing 33 hand-copied variants of each would be 33 places for the assertion to
// drift. These register the shared contract; a config type's own test file calls
// it and adds what is specific to itself — above all deploy's create/update paths
// and the rollback state they record, which are per-resource and live there.
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
  ACTIVATED,
  CannedResponse,
  EMPTY_CREDENTIAL,
  TOKEN,
  activationStatus,
  assertAuthenticatedFirst,
  component,
  deployContext,
  deploymentSummary,
  driftContext,
  forbidden,
  healthContext,
  leaksSecret,
  recordFetch,
  resourceCalls,
  resourceWrites,
  rollbackContext,
  routeFetch,
  serverError,
  settingsWithoutCustomerId,
  statusContext,
  tokenError,
  vendorCalls,
  writeCalls,
  ziaList,
  zpaList,
} from './fakeZscaler'

/** Which product the configuration type manages — they differ in guards and paging. */
export type Product = 'zia' | 'zpa'

/** An empty listing in the product's own envelope. */
function emptyListing(product: Product): CannedResponse {
  return product === 'zia' ? ziaList([]) : zpaList([])
}

/** A component whose hostname is blank — a config type with no tenant registered. */
const UNREGISTERED = () => component({ hostname: '' })

// --- healthCheck --------------------------------------------------------------

export interface HealthCheckContract {
  /** The configuration type's id, used only in test titles. */
  label: string
  handler: (ctx: HealthCheckContext) => Promise<HealthCheckResult>
  product: Product
  /** A substring of the path the reachability probe must hit. */
  probePath: string
  /**
   * What the probe endpoint returns when the tenant is reachable. Defaults to
   * ZIA's activation status / an empty ZPA page, which is what every config type
   * in this app probes with.
   */
  probeResponse?: CannedResponse
}

/** Register the health-check contract every Zscaler configuration type shares. */
export function registerHealthCheckContract(c: HealthCheckContract): void {
  const checkName = `${c.product}_reachable`
  const probe = c.probeResponse ?? (c.product === 'zia' ? activationStatus() : zpaList([]))

  test(`${c.label} healthCheck: refuses without a credential, without calling Zscaler`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Zscaler without a credential')
      assert.ok(
        result.checks.some((check) => check.name === 'zscaler_credential' && check.passed === false),
        `expected a failed "zscaler_credential" check, got ${result.checks.map((x) => x.name).join(', ')}`,
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses a credential with no secret, without calling Zscaler`, async () => {
    // A credential row exists but its secret fields are blank — client-credentials
    // has nothing to present, so there is nothing to try.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: EMPTY_CREDENTIAL }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Zscaler with an unusable credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses when no tenant is registered, without calling Zscaler`, async () => {
    // The vanity domain comes from the component hostname; without it there is
    // no Zidentity login host to authenticate against.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { component: UNREGISTERED() }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach Zscaler without a vanity domain')
    } finally {
      restore()
    }
  })

  if (c.product === 'zpa') {
    test(`${c.label} healthCheck: refuses without a ZPA customer id, without calling Zscaler`, async () => {
      // ZPA paths embed the customer id and the token does not carry it, so a
      // valid credential is still not enough to address the tenant.
      const { calls, restore } = recordFetch([])
      try {
        const result = await c.handler(healthContext([], { settings: settingsWithoutCustomerId() }))

        assert.equal(result.healthy, false)
        assert.equal(result.score, 0)
        assert.equal(calls.length, 0, 'must not reach Zscaler without a ZPA customer id')
        assert.ok(
          result.checks.some((check) => check.name === 'zpa_customer_id' && check.passed === false),
          `expected a failed "zpa_customer_id" check, got ${result.checks.map((x) => x.name).join(', ')}`,
        )
      } finally {
        restore()
      }
    })
  }

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
      assert.equal(result.score, 100)

      const check = result.checks.find((x) => x.name === checkName)
      assert.ok(check, `expected a "${checkName}" check, got ${result.checks.map((x) => x.name).join(', ')}`)
      assert.equal(check.passed, true)
      assert.equal(typeof check.latencyMs, 'number')
      assert.equal(leaksSecret(result), false, 'health result must not carry the token or client secret')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports a rejected credential rather than throwing`, async () => {
    const { calls, restore } = routeFetch([], forbidden())
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === checkName)
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /rejected the OneAPI credential/)
      assert.equal(leaksSecret(result), false)
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: surfaces the vendor's error rather than throwing`, async () => {
    const { calls, restore } = routeFetch([], serverError('Internal server error'))
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === checkName)
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /Internal server error/)
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
  product: Product
  /**
   * A canvas the config type would otherwise deploy. Every assertion here is
   * about refusing BEFORE the canvas matters, so an empty canvas is fine — pass
   * items only to prove the refusal survives real work being requested.
   */
  items?: CanvasItemSnapshot[]
}

/**
 * Register the refusals every Zscaler deploy shares. The value of each is the
 * zero-call assertion: a handler that returns `success: false` AFTER writing
 * half a policy set has still changed the customer's tenant.
 */
export function registerDeployGuardContract(c: DeployGuardContract): void {
  const items = c.items ?? []

  test(`${c.label} deploy: refuses without a credential, without calling Zscaler`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(items, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Zscaler without a credential')
      assert.match(String(result.message), /No Zscaler OneAPI credential available/)
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses a credential with no secret, without calling Zscaler`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(items, { credential: EMPTY_CREDENTIAL }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Zscaler with an unusable credential')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses when no tenant is registered, without calling Zscaler`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(items, { component: UNREGISTERED() }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Zscaler without a vanity domain')
      assert.match(String(result.message), /vanity domain/)
    } finally {
      restore()
    }
  })

  if (c.product === 'zpa') {
    test(`${c.label} deploy: refuses without a ZPA customer id, without calling Zscaler`, async () => {
      const { calls, restore } = recordFetch([])
      try {
        const result = await c.handler(deployContext(items, { settings: settingsWithoutCustomerId() }))

        assert.equal(result.success, false)
        assert.equal(calls.length, 0, 'must not reach Zscaler without a ZPA customer id')
        assert.match(String(result.message), /No ZPA customer id configured/)
      } finally {
        restore()
      }
    })
  }

  test(`${c.label} deploy: a rejected token exchange fails the deploy without writing`, async () => {
    const { calls, restore } = recordFetch([tokenError(), tokenError(), tokenError(), tokenError()])
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
  product: Product
  /**
   * The key a rollback entry stores its object's identity under — `name` for
   * most, `configuredName`/`loginName`/`sourceIp`/`ipAddress` for a few.
   */
  nameKey: string
}

/**
 * Register the rollback refusals every Zscaler configuration type shares.
 *
 * The two that matter are the last two: an entry recording an object that was
 * CREATED but whose id was never captured, and an entry recording an object that
 * was UPDATED but whose prior body was never captured. Neither can be undone, and
 * the only safe response is to touch nothing — a rollback that invents a body is
 * how a hand-tuned production rule gets replaced with a default.
 */
export function registerRollbackGuardContract(c: RollbackGuardContract): void {
  const entry = (over: Record<string, unknown>) => ({ [c.nameKey]: 'veltrix-test-object', ...over })

  test(`${c.label} rollback: refuses without a credential, without calling Zscaler`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(
        rollbackContext({ previousState: [entry({ existed: false, id: '42' })] }, { credential: null }),
      )

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach Zscaler without a credential')
      assert.match(String(result.message), /No Zscaler OneAPI credential available/)
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

  test(`${c.label} rollback: makes no call for a created entry whose id was never captured`, async () => {
    // Deploy created the object but never recorded its id. There is no safe
    // DELETE to issue, and guessing one would delete somebody else's object.
    const { calls, restore } = routeFetch([], emptyListing(c.product))
    try {
      await c.handler(rollbackContext({ previousState: [entry({ existed: false })] }))

      assert.equal(
        resourceCalls(calls).length,
        0,
        `expected no resource call, got ${resourceCalls(calls)
          .map((x) => `${x.method} ${x.url}`)
          .join(', ')}`,
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: writes nothing for an updated entry whose prior state was never captured`, async () => {
    // Deploy overwrote a live object but recorded no prior body. Restoring an
    // invented default here is strictly worse than leaving the object alone.
    const { calls, restore } = routeFetch([], emptyListing(c.product))
    try {
      await c.handler(rollbackContext({ previousState: [entry({ existed: true, id: '42' })] }))

      assert.equal(
        resourceWrites(calls).length,
        0,
        `expected no resource write, got ${resourceWrites(calls)
          .map((x) => `${x.method} ${x.url}`)
          .join(', ')}`,
      )
    } finally {
      restore()
    }
  })

  if (c.product === 'zpa') {
    test(`${c.label} rollback: makes no call without a ZPA customer id`, async () => {
      const { calls, restore } = recordFetch([])
      try {
        const result = await c.handler(
          rollbackContext(
            { previousState: [entry({ existed: false, id: '42' })] },
            { settings: settingsWithoutCustomerId() },
          ),
        )

        assert.equal(result.success, false)
        assert.equal(calls.length, 0, 'ZPA is unaddressable without a customer id')
      } finally {
        restore()
      }
    })
  }
}

// --- driftDetect --------------------------------------------------------------

export interface DriftContract {
  label: string
  handler: (ctx: DriftContext) => Promise<DriftResult>
  product: Product
  /** One declared object, exactly as the deployed canvas stored it. */
  items: CanvasItemSnapshot[]
}

/**
 * Register the drift-detection contract every Zscaler configuration type shares.
 *
 * The load-bearing one is the last: a listing that answered 500 means "I could
 * not look", and a handler that lets that become an empty list reports every
 * managed object as deleted. That is the defect this catalog has hit most often.
 */
export function registerDriftContract(c: DriftContract): void {
  test(`${c.label} driftDetect: never writes`, async () => {
    // Everything absent — the branch that produces the most diffs — must still
    // produce no change to the tenant.
    const { calls, restore } = routeFetch([], emptyListing(c.product))
    try {
      await c.handler(driftContext(c.items))

      assert.equal(
        writeCalls(calls).length,
        0,
        `drift wrote: ${writeCalls(calls)
          .map((x) => `${x.method} ${x.url}`)
          .join(', ')}`,
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: makes no call without a credential`, async () => {
    // NOTE: what this handler RETURNS on this path is deliberately not asserted.
    // It returns a bare `hasDrift: false`, which the platform reads as a positive
    // "I checked and found nothing" and uses to resolve outstanding drift records
    // — see the report accompanying these tests. Asserting it would bless it.
    const { calls, restore } = recordFetch([])
    try {
      await c.handler(driftContext(c.items, { credential: null }))

      assert.equal(calls.length, 0, 'must not reach Zscaler without a credential')
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
    const { calls, restore } = routeFetch([], emptyListing(c.product))
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(result.hasDrift, true, 'an object deleted in the tenant is drift')
      assert.ok(
        result.diffs.some((d) => d.actual === 'missing' && d.severity === 'critical'),
        `expected a critical "missing" diff, got ${JSON.stringify(result.diffs)}`,
      )
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksSecret(result), false, 'a diff must not carry the token or client secret')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: a failed read is never reported as the objects being gone`, async () => {
    // The vendor answered 500. That is "I could not look", not "there are none",
    // and turning it into `actual: 'missing'` tells an operator their production
    // policy was deleted.
    const { calls, restore } = routeFetch([], serverError())
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(
        result.diffs.some((d) => d.actual === 'missing'),
        false,
        `a 500 became "missing": ${JSON.stringify(result.diffs)}`,
      )
      assert.ok(
        result.hasDrift === true || (result as { checked?: boolean }).checked === false,
        'an unreadable tenant must not come back as a bare, positive "no drift"',
      )
      assert.equal(writeCalls(calls).length, 0)
      assert.equal(leaksSecret(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: a rejected token exchange is reported, not thrown`, async () => {
    const { calls, restore } = recordFetch([tokenError(), tokenError(), tokenError(), tokenError()])
    try {
      const result = await c.handler(driftContext(c.items))

      assert.equal(
        result.diffs.some((d) => d.actual === 'missing'),
        false,
        'a failed token exchange must not read as the objects being gone',
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
 * Register the getStatus contract every Zscaler configuration type shares —
 * it is byte-identical in all 33.
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
      assert.equal(calls.length, 0, 'getStatus reads platform records only — it must not call Zscaler')
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
      assert.deepEqual(probe.componentQueries, [{ types: ['zscaler-tenant'] }])
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
    assert.equal(status.componentStatuses[0].lastDeployedAt, '', 'a per-component time is only reported once complete')
  })

  test(`${c.label} getStatus: carries the recorded health score through, and its 80 threshold`, async () => {
    const healthy = await c.handler(statusContext(c.configTypeId, { latest: deploymentSummary({ healthScore: 80 }) }).ctx)
    assert.equal(healthy.componentStatuses[0].healthScore, 80)
    assert.equal(healthy.componentStatuses[0].healthy, true)

    const degraded = await c.handler(statusContext(c.configTypeId, { latest: deploymentSummary({ healthScore: 79 }) }).ctx)
    assert.equal(degraded.componentStatuses[0].healthScore, 79)
    assert.equal(degraded.componentStatuses[0].healthy, false)

    const unknown = await c.handler(statusContext(c.configTypeId, { latest: deploymentSummary({ healthScore: null }) }).ctx)
    assert.equal(unknown.componentStatuses[0].healthScore, undefined)
    assert.equal(unknown.componentStatuses[0].healthy, undefined, 'no recorded score means unknown, not unhealthy')
  })

  test(`${c.label} getStatus: reports every registered tenant, and none when there are none`, async () => {
    const two = statusContext(c.configTypeId, {
      latest: deploymentSummary(),
      components: [
        { id: 'comp-1', hostname: 'acme.zslogin.net', port: '443', type: ['zscaler-tenant'], toolId: 'zscaler' },
        { id: 'comp-2', hostname: 'beta.zslogin.net', port: '443', type: ['zscaler-tenant'], toolId: 'zscaler' },
      ],
    })
    const status = await c.handler(two.ctx)
    assert.deepEqual(
      status.componentStatuses.map((s) => s.hostname),
      ['acme.zslogin.net', 'beta.zslogin.net'],
    )

    const none = statusContext(c.configTypeId, { latest: deploymentSummary(), components: [] })
    const empty = await c.handler(none.ctx)
    assert.equal(empty.deployed, true)
    assert.deepEqual(empty.componentStatuses, [])
  })
}

/** Re-exported so a config type's own tests need only one import path. */
export { ACTIVATED, TOKEN }
