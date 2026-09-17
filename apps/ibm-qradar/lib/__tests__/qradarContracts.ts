// =============================================================================
// Reusable handler contracts for the IBM QRadar app, built on fakeQRadar.
//
// Four of this app's six handlers are uniform across all 24 configuration types
// once you strip the resource name out of them:
//
//   getStatus    — byte-identical in every config type: it reads the platform's
//                  own deployment record plus the registered component, and
//                  never touches QRadar.
//   healthCheck  — the same four steps everywhere: read the settings, fail
//                  closed if the credential or the console host is unusable,
//                  probe ONE endpoint with `Range: items=0-0`, and score the
//                  result 100 or 0.
//   deploy       — the same pre-flight refusal before the first request.
//   rollback     — the same refusal, plus the rule that nothing recorded means
//                  no call rather than an invented write.
//   driftDetect  — the same refusal (as `checked: false`, never a bare
//                  "in sync"), plus the rule that drift never writes.
//
// Writing 24 hand-copied variants of each would be 24 places for the assertion
// to drift. These register the shared contract; a config type's own test file
// calls it and adds what is specific to itself — above all deploy's
// create/update paths and the rollback state they record, which are per-resource
// and live there.
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
  API_VERSION,
  BASE_URL,
  CannedResponse,
  EMPTY_CREDENTIAL,
  SEC_TOKEN,
  assertQRadarHeaders,
  deployContext,
  deploymentSummary,
  driftContext,
  forbidden,
  healthContext,
  leaksToken,
  list,
  ok,
  pathOf,
  recordFetch,
  rollbackContext,
  routeFetch,
  serverError,
  settingsWithoutHost,
  statusContext,
  transportFailure,
  unauthorized,
  writeCalls,
} from './fakeQRadar'

// --- getStatus ----------------------------------------------------------------

export interface GetStatusContract {
  /** The configuration type's id, used in test titles and as `configTypeId`. */
  label: string
  handler: (ctx: PipelineContext) => Promise<ConfigStatus>
}

/** Register the getStatus contract every QRadar configuration type shares. */
export function registerGetStatusContract(c: GetStatusContract): void {
  test(`${c.label} getStatus: reads the platform's records and never touches QRadar`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, { latest: deploymentSummary() })
      const result = await c.handler(probe.ctx)

      assert.equal(calls.length, 0, 'getStatus must not reach the QRadar console')
      assert.equal(result.deployed, true)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: asks only for SUCCEEDED deployments of this canvas`, async () => {
    const { restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, { latest: deploymentSummary() })
      await c.handler(probe.ctx)

      assert.equal(probe.deploymentQueries.length, 1)
      assert.equal(probe.deploymentQueries[0].canvasId, 'canvas-1')
      assert.equal(
        probe.deploymentQueries[0].status,
        'SUCCEEDED',
        'a FAILED deployment must not read as "deployed"',
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: reports not deployed when no deployment succeeded`, async () => {
    const { restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, { latest: null })
      const result = await c.handler(probe.ctx)

      assert.equal(result.deployed, false)
      assert.equal(result.lastDeployedAt, '')
      assert.equal(result.componentStatuses.length, 1)
      assert.equal(result.componentStatuses[0].deployed, false)
      assert.equal(result.componentStatuses[0].lastDeployedAt, undefined)
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: reports the completion time and the canvas version`, async () => {
    const { restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, {
        latest: deploymentSummary({ completedAt: '2026-02-03T09:05:00.000Z' }),
        version: 7,
      })
      const result = await c.handler(probe.ctx)

      assert.equal(result.deployed, true)
      assert.equal(result.lastDeployedAt, '2026-02-03T09:05:00.000Z')
      assert.equal(result.version, '7')
      assert.equal(result.componentStatuses[0].componentId, 'comp-1')
      assert.equal(result.componentStatuses[0].hostname, 'qradar.example.test')
      assert.equal(result.componentStatuses[0].lastDeployedAt, '2026-02-03T09:05:00.000Z')
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: falls back to the start time for a deployment still finishing`, async () => {
    const { restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, {
        latest: deploymentSummary({ completedAt: null, startedAt: '2026-02-03T09:00:00.000Z' }),
      })
      const result = await c.handler(probe.ctx)

      assert.equal(result.lastDeployedAt, '2026-02-03T09:00:00.000Z')
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: reports no component status when nothing is registered`, async () => {
    const { restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, { latest: deploymentSummary(), component: null })
      const result = await c.handler(probe.ctx)

      assert.deepEqual(result.componentStatuses, [])
      assert.equal(result.deployed, true, 'the deployment record stands even with no component')
    } finally {
      restore()
    }
  })

  test(`${c.label} getStatus: a failing platform read does not crash the pipeline`, async () => {
    // NOTE: the handler swallows the error and falls through to "not deployed".
    // That conflates "could not read" with "never deployed" — reported as a
    // defect, so this asserts only that the pipeline gets a result rather than
    // an exception, and does NOT bless the conclusion.
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.label, { platformFails: true })
      const result = await c.handler(probe.ctx)

      assert.ok(result, 'getStatus must return a result rather than throw')
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })
}

// --- healthCheck --------------------------------------------------------------

export interface HealthCheckContract {
  label: string
  handler: (ctx: HealthCheckContext) => Promise<HealthCheckResult>
  /** The exact path the reachability probe must hit, without the `/api` base. */
  probePath: string
  /** The name of the check the probe result is reported under. */
  checkName: string
}

/** Register the health-check contract every QRadar configuration type shares. */
export function registerHealthCheckContract(c: HealthCheckContract): void {
  test(`${c.label} healthCheck: refuses without a credential, without calling QRadar`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach QRadar without a credential')
      assert.ok(
        result.checks.some((check) => check.name === 'credential' && check.passed === false),
        `expected a failed "credential" check, got ${result.checks.map((x) => x.name).join(', ')}`,
      )
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses a credential with no token, without calling QRadar`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { credential: EMPTY_CREDENTIAL }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'a blank token has nothing to present')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: refuses when no console host is configured`, async () => {
    // Without `console_host` there is no base URL to address, so there is
    // nothing to try — not even a request that would fail.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext([], { settings: settingsWithoutHost() }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach QRadar with no console host')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: probes the console with the SEC token and declared version`, async () => {
    const { calls, restore } = recordFetch([list([])])
    try {
      const result = await c.handler(healthContext([]))

      assertQRadarHeaders(assert, calls)
      assert.equal(calls.length, 1, 'the probe is a single request')
      assert.equal(calls[0].method, 'GET')
      assert.equal(pathOf(calls[0]), c.probePath)
      assert.equal(calls[0].range, 'items=0-0', 'a reachability probe asks for one row, not the list')
      assert.equal(calls[0].sec, SEC_TOKEN)
      assert.equal(calls[0].version, API_VERSION)
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')

      assert.equal(result.healthy, true)
      assert.equal(result.score, 100, 'score is a percentage, not a fraction')
      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check, `expected a "${c.checkName}" check, got ${result.checks.map((x) => x.name).join(', ')}`)
      assert.equal(check.passed, true)
      assert.equal(typeof check.latencyMs, 'number')
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports a rejected token as unhealthy without leaking it`, async () => {
    const { calls, restore } = recordFetch([unauthorized('SEC header is invalid or the service is not authorized')])
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.match(String(check.message), /SEC header is invalid/)
      assert.equal(leaksToken(result), false, 'the failure message must not echo the token back')
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports a missing capability rather than throwing`, async () => {
    const { restore } = recordFetch([forbidden('You do not have the required capability for this endpoint')])
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.match(String(result.checks[0].message), /required capability/)
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports an unreachable console rather than throwing`, async () => {
    const { restore } = recordFetch([transportFailure()])
    try {
      const result = await c.handler(healthContext([]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.match(String(result.checks[0].message), /ENOTFOUND/)
    } finally {
      restore()
    }
  })
}

// --- deploy -------------------------------------------------------------------

export interface DeployGuardContract {
  label: string
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /** One canvas item this config type would deploy, so the refusal is not vacuous. */
  sampleItems: CanvasItemSnapshot[]
}

/**
 * Register the pre-flight refusals every QRadar deploy shares. The item list
 * matters: a handler that refused only because there was nothing to do would
 * pass a test with an empty canvas and still write with a broken credential.
 */
export function registerDeployGuardContract(c: DeployGuardContract): void {
  test(`${c.label} deploy: refuses without a credential, without calling QRadar`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(c.sampleItems, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach QRadar without a credential')
      assert.match(String(result.message), /No usable IBM QRadar credential/)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses a credential with no token, without calling QRadar`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(c.sampleItems, { credential: EMPTY_CREDENTIAL }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: refuses when no console host is configured`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(deployContext(c.sampleItems, { settings: settingsWithoutHost() }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach QRadar with no console host')
      assert.match(String(result.message), /Console Host/)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: reaches the console with the SEC token once the credential is usable`, async () => {
    // The mirror of the three refusals above: with a working credential the
    // handler must actually go to the console, and every request must carry the
    // authorized-service token and the declared API version.
    const { calls, restore } = routeFetch([], list([]))
    try {
      await c.handler(deployContext(c.sampleItems))

      assert.ok(calls.length > 0, 'a usable credential must reach the console')
      assert.equal(calls[0].sec, SEC_TOKEN)
      assert.equal(calls[0].version, API_VERSION)
      assert.ok(calls[0].url.startsWith(`${BASE_URL}/`))
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
   * Whether an empty/absent rollbackData must produce ZERO console calls.
   * True everywhere except the whole-list singleton types, whose behaviour with
   * nothing recorded is reported as a defect rather than asserted here.
   */
  emptyRollbackDataMakesNoCall?: boolean
}

/** Register the refusals every QRadar rollback shares. */
export function registerRollbackGuardContract(c: RollbackGuardContract): void {
  test(`${c.label} rollback: refuses without a credential, without calling QRadar`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(rollbackContext({ entries: [] }, { credential: null }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0, 'must not reach QRadar without a credential')
      assert.match(String(result.message), /No usable IBM QRadar credential/)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: refuses when no console host is configured`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(rollbackContext({ entries: [] }, { settings: settingsWithoutHost() }))

      assert.equal(result.success, false)
      assert.equal(calls.length, 0)
    } finally {
      restore()
    }
  })

  if (c.emptyRollbackDataMakesNoCall !== false) {
    test(`${c.label} rollback: writes nothing when the deploy recorded nothing`, async () => {
      // A rollback with no recorded prior state must not invent one. Three
      // shapes reach here in practice: no rollbackData at all, an unrelated
      // object, and an explicitly empty entry list.
      for (const data of [undefined, {}, { entries: [] }, { entries: 'not-an-array' }]) {
        const { calls, restore } = recordFetch([])
        try {
          const result = await c.handler(rollbackContext(data))

          assert.equal(calls.length, 0, `rollbackData ${JSON.stringify(data ?? null)} must produce no call`)
          assert.equal(result.success, true, 'nothing to undo is not a failure')
        } finally {
          restore()
        }
      }
    })
  }
}

// --- driftDetect --------------------------------------------------------------

export interface DriftGuardContract {
  label: string
  handler: (ctx: DriftContext) => Promise<DriftResult>
  /** Items the last deploy recorded, so the guard is not vacuous. */
  sampleItems: CanvasItemSnapshot[]
}

/** Register the rules every QRadar driftDetect shares. */
export function registerDriftGuardContract(c: DriftGuardContract): void {
  test(`${c.label} driftDetect: reports "could not check" without a credential`, async () => {
    // `hasDrift: false` is a positive assurance the platform acts on — it
    // clears any outstanding drift record. A run that could not look must say
    // so with `checked: false`.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext(c.sampleItems, { credential: null }))

      assert.equal(calls.length, 0, 'must not reach QRadar without a credential')
      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
      assert.equal(result.checked, false, 'a run that could not look must not claim it checked')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports "could not check" with no console host`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(driftContext(c.sampleItems, { settings: settingsWithoutHost() }))

      assert.equal(calls.length, 0)
      assert.equal(result.checked, false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: never writes to the console`, async () => {
    const { calls, restore } = routeFetch([], list([]))
    try {
      const result = await c.handler(driftContext(c.sampleItems))

      assert.equal(writeCalls(calls).length, 0, 'drift detection is read-only')
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })
}

/** Re-exported so a config type's test file imports one module for the basics. */
export { BASE_URL, SEC_TOKEN, API_VERSION, ok, list, serverError, type CannedResponse }
