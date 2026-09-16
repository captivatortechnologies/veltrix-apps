// =============================================================================
// The `healthCheck` contract every FortiManager configuration type must satisfy.
//
// The probe is one `get` on the ADOM object table this type manages, which
// proves three things in a single call: the FortiManager answered, the admin
// credential logged in, and that admin can read this ADOM's object database.
//
// Two things make it worth asserting rather than assuming:
//
//   * it must fail CLOSED. A connection with no credential, no password or no
//     host is not "healthy until proven otherwise" — it must report unhealthy
//     without sending anything.
//   * FortiManager refuses inside a 200. A probe that reads `res.ok` from fetch
//     shows a green connection for an admin whose ADOM access was revoked,
//     while every deploy through it fails.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  ADOM,
  CREDENTIAL_WITHOUT_PASSWORD,
  LOGIN_OK,
  LOGOUT_OK,
  assertLoggedInFirst,
  assertLoggedOut,
  healthContext,
  leaksSecret,
  loginFailure,
  mutatingCalls,
  rpcError,
  rpcOk,
  withFmg,
  withUnreachableFmg,
} from './fakeFmg'
import { urlFor, type ConfigFixture } from './configFixture'

type HealthCheckHandler = (ctx: HealthCheckContext) => Promise<HealthCheckResult>

/** Register the healthCheck contract suite for one configuration type. */
export function describeHealthCheckContract(fx: ConfigFixture, healthCheck: HealthCheckHandler): void {
  const label = `fortimanager ${fx.id} healthCheck`
  const url = urlFor(fx, ADOM)

  test(`${label} fails closed without a credential instead of probing FortiManager`, async () => {
    await withFmg([], async (calls) => {
      const result = await healthCheck(healthContext({ credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks.length, 1)
      assert.equal(result.checks[0].name, 'credential')
      assert.equal(result.checks[0].passed, false)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} fails closed when the credential carries no password`, async () => {
    await withFmg([], async (calls) => {
      const result = await healthCheck(healthContext({ credential: CREDENTIAL_WITHOUT_PASSWORD }))

      assert.equal(result.healthy, false)
      assert.equal(result.checks[0].name, 'credential')
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} fails closed when the Host setting is blank`, async () => {
    await withFmg([], async (calls) => {
      const result = await healthCheck(healthContext({ settings: {} }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} logs in and reads the ADOM object table it manages`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), LOGOUT_OK], async (calls) => {
      const result = await healthCheck(healthContext())

      const work = assertLoggedInFirst(assert, calls)
      assert.equal(work.length, 1, 'the probe is one read, not a sweep of the ADOM')
      assert.equal(work[0].rpcMethod, 'get')
      assert.equal(work[0].rpcUrl, url)
      assertLoggedOut(assert, calls)

      assert.equal(result.healthy, true)
      assert.equal(result.score, 100, 'the platform renders this as a percentage — a fraction shows 1%')
      assert.equal(result.checks.length, 1)
      assert.equal(result.checks[0].name, fx.checkName)
      assert.equal(result.checks[0].passed, true)
      assert.notEqual(result.checks[0].latencyMs, undefined)
    })
  })

  test(`${label} never writes to the ADOM`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.livePrior]), LOGOUT_OK], async (calls) => {
      await healthCheck(healthContext())

      assert.equal(mutatingCalls(calls).length, 0, 'a reachability probe must not change a customer’s objects')
    })
  })

  test(`${label} reports unhealthy when FortiManager refuses the read inside a 200`, async () => {
    await withFmg([LOGIN_OK, rpcError('no permission for the resource', -6), LOGOUT_OK], async () => {
      const result = await healthCheck(healthContext())

      assert.equal(result.healthy, false, 'HTTP 200 with a non-zero status.code is a refusal, not a green light')
      assert.equal(result.score, 0)
      assert.equal(result.checks[0].name, fx.checkName)
      assert.equal(result.checks[0].passed, false)
      assert.match(result.checks[0].message, /no permission for the resource/)
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} reports unhealthy when the login is rejected, without echoing the password`, async () => {
    await withFmg([loginFailure('Login fail: wrong password')], async (calls) => {
      const result = await healthCheck(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.checks[0].passed, false)
      assert.match(result.checks[0].message, /Login fail/)
      assert.equal(leaksSecret(result), false, 'the remedy has to be nameable without quoting the credential')
      assert.equal(mutatingCalls(calls).length, 0)
    })
  })

  test(`${label} reports unhealthy rather than throwing when FortiManager is unreachable`, async () => {
    await withUnreachableFmg(async () => {
      const result = await healthCheck(healthContext())

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks[0].passed, false)
      assert.match(result.checks[0].message, /ECONNREFUSED/)
      assert.notEqual(result.checks[0].latencyMs, undefined)
    })
  })

  test(`${label} probes the configured ADOM, not root`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), LOGOUT_OK], async (calls) => {
      const result = await healthCheck(healthContext({ adom: 'customer-a' }))

      const reads = calls.filter((c) => c.rpcMethod === 'get')
      assert.equal(reads.length, 1)
      assert.equal(reads[0].rpcUrl, urlFor(fx, 'customer-a'))
      assert.match(result.checks[0].message, /customer-a/)
    })
  })
}
