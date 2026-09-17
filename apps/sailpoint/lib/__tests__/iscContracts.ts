// =============================================================================
// Reusable handler contracts for the SailPoint ISC app, built on fakeIsc.
//
// Two of this app's six handlers are uniform across all 31 configuration types:
//
//   getStatus    — identical in every config type: it reads the platform's own
//                  deployment record and never touches ISC.
//   healthCheck  — the same three steps everywhere: resolve the credential, fail
//                  closed if it is unusable, otherwise probe ONE ISC endpoint.
//
// Writing 31 hand-copied variants of each would be 31 places for the assertion to
// drift. These register the shared contract; a config type's own test file calls
// it with the endpoint it probes and adds anything specific to itself.
//
// This is NOT a test file — the runner only collects `*.test.ts`.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ConfigStatus,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
} from '@veltrixsecops/app-sdk'
import {
  ACCESS_TOKEN,
  CLIENT_SECRET,
  TOKEN,
  assertAuthenticatedFirst,
  deploymentSummary,
  healthContext,
  iscError,
  leaksSecret,
  listPage,
  pathOf,
  recordFetch,
  statusContext,
  tokenError,
  vendorCalls,
  writeCalls,
  type CannedResponse,
} from './fakeIsc'

// --- healthCheck --------------------------------------------------------------

export interface HealthCheckContract {
  /** The configuration type's id, used only in test titles. */
  label: string
  handler: (ctx: HealthCheckContext) => Promise<HealthCheckResult>
  /** The `checks[].name` the handler reports for its ISC probe. */
  checkName: string
  /** A substring of the ISC path the probe must hit. */
  path: string
  /** What the probe endpoint returns when reachable. Defaults to an empty list. */
  probeResponse?: CannedResponse
}

/** Register the health-check contract every ISC configuration type shares. */
export function registerHealthCheckContract(c: HealthCheckContract): void {
  const probe = c.probeResponse ?? listPage([])

  test(`${c.label} healthCheck: fails closed without a credential, without calling ISC`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext({ credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach ISC without a credential')
      assert.ok(
        result.checks.some((check) => check.name === 'credential' && check.passed === false),
        'expected a failed "credential" check',
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: fails closed when the tenant setting is missing`, async () => {
    // A credential alone is not enough — without the org name there is no tenant
    // API host to resolve, so there is no token endpoint to call at all.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(healthContext({ settings: {} }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0, 'must not reach ISC without a tenant')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: acquires a token before probing, and reports healthy`, async () => {
    const { calls, restore } = recordFetch([TOKEN, probe])
    try {
      const result = await c.handler(healthContext())

      const iscCalls = assertAuthenticatedFirst(assert, calls)
      assert.equal(iscCalls.length, 1, 'health check should make exactly one ISC call')
      assert.equal(iscCalls[0].method, 'GET')
      assert.ok(
        pathOf(iscCalls[0]).startsWith(c.path),
        `probe hit ${pathOf(iscCalls[0])}, expected it to start with ${c.path}`,
      )
      assert.equal(result.healthy, true)
      assert.equal(result.score, 100)

      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check, `expected a "${c.checkName}" check, got ${result.checks.map((x) => x.name).join(', ')}`)
      assert.equal(check.passed, true)
      assert.equal(typeof check.latencyMs, 'number')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: reports unhealthy with the ISC error, leaking no secret`, async () => {
    const { calls, restore } = recordFetch([
      TOKEN,
      iscError(403, 'The user does not have the right scopes to perform this operation.'),
    ])
    try {
      const result = await c.handler(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      const check = result.checks.find((x) => x.name === c.checkName)
      assert.ok(check)
      assert.equal(check.passed, false)
      assert.ok(
        String(check.message).includes('does not have the right scopes'),
        `expected the ISC message to be surfaced, got: ${check.message}`,
      )
      assert.equal(leaksSecret(result), false, 'health result must not carry the token or client secret')
      assert.equal(writeCalls(calls).length, 0, 'a health check must never write')
    } finally {
      restore()
    }
  })

  test(`${c.label} healthCheck: a rejected token exchange is reported, not thrown`, async () => {
    const { calls, restore } = recordFetch([tokenError()])
    try {
      const result = await c.handler(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(vendorCalls(calls).length, 0, 'no ISC call may follow a failed token exchange')
      assert.equal(leaksSecret(result), false)
      assert.equal(
        JSON.stringify(result).includes(ACCESS_TOKEN) || JSON.stringify(result).includes(CLIENT_SECRET),
        false,
      )
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

/** Register the getStatus contract every ISC configuration type shares. */
export function registerGetStatusContract(c: GetStatusContract): void {
  test(`${c.label} getStatus: reports not deployed when no successful deployment exists`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const probe = statusContext(c.configTypeId, { latest: null })
      const status = await c.handler(probe.ctx)

      assert.equal(status.deployed, false)
      assert.equal(status.lastDeployedAt, '')
      assert.equal(calls.length, 0, 'getStatus reads platform records only — it must not call ISC')
      assert.deepEqual(probe.deploymentQueries, [{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
      assert.equal(status.componentStatuses.length, 1)
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
      assert.equal(status.lastDeployedAt, '2026-01-01T09:05:00.000Z')
      assert.equal(status.version, '11')
      assert.equal(status.componentStatuses[0].componentId, 'comp-1')
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

  test(`${c.label} getStatus: absorbs a platform lookup failure instead of throwing`, async () => {
    const probe = statusContext(c.configTypeId, { latest: 'throws' })
    const status = await c.handler(probe.ctx)

    assert.equal(status.deployed, false)
    assert.equal(status.lastDeployedAt, '')
  })

  test(`${c.label} getStatus: reports no component statuses when no component is bound`, async () => {
    const probe = statusContext(c.configTypeId, { latest: deploymentSummary(), component: null })
    const status = await c.handler(probe.ctx)

    assert.equal(status.deployed, true)
    assert.deepEqual(status.componentStatuses, [])
  })
}
