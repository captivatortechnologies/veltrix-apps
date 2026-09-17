// =============================================================================
// The `healthCheck` contract every Panorama configuration type must satisfy.
//
// The probe is one REST listing of the collection this type manages, which
// proves three things in a single call: Panorama answered, the API key is valid,
// and the admin behind that key can read this device group. Every object the
// canvas declares is then checked for presence in what came back.
//
// Two things make it worth asserting rather than assuming:
//
//   * it must fail CLOSED. A config type with no credential, no usable key or no
//     hostname is not "healthy until proven otherwise" — it must report
//     unhealthy without sending anything.
//
//   * `score` is a PERCENTAGE. The console renders it as `<score>%` and bands it
//     at 80 and 50, so a handler returning the fraction shows a perfectly
//     healthy deployment as "1%", in red.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  CREDENTIAL_WITHOUT_KEY,
  COMPONENT_WITHOUT_HOSTNAME,
  DEVICE_GROUP,
  assertScopedAndAuthenticated,
  healthContext,
  leaksSecret,
  listOk,
  listSingle,
  mutatingCalls,
  restError,
  withPanorama,
} from './fakePanorama'
import { bystanderEntry, liveInSyncEntry, type ConfigFixture } from './configFixture'

type HealthCheckHandler = (ctx: HealthCheckContext) => Promise<HealthCheckResult>

/** Register the healthCheck contract suite for one configuration type. */
export function describeHealthCheckContract(fx: ConfigFixture, healthCheck: HealthCheckHandler): void {
  const label = `panorama ${fx.id} healthCheck`
  const objectCheck = `${fx.healthLabel}:${fx.name}`

  test(`${label} fails closed without a credential instead of probing Panorama`, async () => {
    await withPanorama([], async (calls) => {
      const result = await healthCheck(healthContext([fx.item], { credential: null }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks.length, 1)
      assert.equal(result.checks[0].name, 'panorama_credential')
      assert.equal(result.checks[0].passed, false)
      assert.match(result.checks[0].message, /No Panorama API key/)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} fails closed when the credential carries no key`, async () => {
    await withPanorama([], async (calls) => {
      const result = await healthCheck(healthContext([fx.item], { credential: CREDENTIAL_WITHOUT_KEY }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks[0].name, 'panorama_credential')
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} fails closed when the component has no hostname`, async () => {
    await withPanorama([], async (calls) => {
      const result = await healthCheck(healthContext([fx.item], { component: COMPONENT_WITHOUT_HOSTNAME }))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks[0].passed, false)
      assert.match(result.checks[0].message, /No Panorama host/)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} reads the collection it manages and reports the declared object present`, async () => {
    await withPanorama([listOk([bystanderEntry(fx), liveInSyncEntry(fx)])], async (calls) => {
      const result = await healthCheck(healthContext([fx.item]))

      assertScopedAndAuthenticated(assert, calls)
      assert.equal(calls.length, 1, 'the probe is one read, not a sweep of the device group')
      assert.equal(calls[0].method, 'GET')
      assert.equal(calls[0].resourcePath, fx.resourcePath)
      assert.equal(calls[0].hasName, false)

      assert.equal(result.healthy, true)
      assert.equal(result.score, 100, 'the platform renders this as a percentage — a fraction shows 1%')
      assert.deepEqual(
        result.checks.map((c) => c.name),
        ['panorama_reachable', objectCheck],
      )
      assert.equal(result.checks[0].passed, true)
      assert.match(result.checks[0].message, /panorama\.example\.com/)
      assert.match(result.checks[0].message, new RegExp(DEVICE_GROUP))
      assert.notEqual(result.checks[0].latencyMs, undefined)
      assert.equal(result.checks[1].passed, true)
      assert.match(result.checks[1].message, /is present/)
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} sees an object Panorama returned in the single-entry shape`, async () => {
    await withPanorama([listSingle(liveInSyncEntry(fx))], async () => {
      const result = await healthCheck(healthContext([fx.item]))

      assert.equal(result.healthy, true, 'a collection of one comes back as a bare object, not a one-element array')
      assert.equal(result.score, 100)
    })
  })

  test(`${label} reports the declared object missing and scores the run down`, async () => {
    await withPanorama([listOk([bystanderEntry(fx)])], async () => {
      const result = await healthCheck(healthContext([fx.item]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 50, '1 of 2 checks passed — reachable, but the object is gone')
      assert.equal(result.checks[1].name, objectCheck)
      assert.equal(result.checks[1].passed, false)
      assert.match(result.checks[1].message, /is missing/)
    })
  })

  test(`${label} scores every declared object, not just the first`, async () => {
    await withPanorama([listOk([liveInSyncEntry(fx)])], async () => {
      const result = await healthCheck(healthContext([fx.item, fx.secondItem]))

      assert.equal(result.checks.length, 3)
      assert.equal(result.checks[2].name, `${fx.healthLabel}:${fx.secondName}`)
      assert.equal(result.checks[2].passed, false)
      assert.equal(result.score, 67, 'percentage, rounded — 2 of 3 checks passed')
      assert.equal(result.healthy, false)
    })
  })

  test(`${label} reports unhealthy when Panorama refuses the read`, async () => {
    await withPanorama([restError(403, 'User is not authorized for this device group')], async () => {
      const result = await healthCheck(healthContext([fx.item]))

      assert.equal(result.healthy, false)
      assert.equal(result.score, 0)
      assert.equal(result.checks.length, 1)
      assert.equal(result.checks[0].name, 'panorama_reachable')
      assert.equal(result.checks[0].passed, false)
      assert.match(result.checks[0].message, /not authorized/)
      assert.notEqual(result.checks[0].latencyMs, undefined)
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} never changes the customer's configuration`, async () => {
    await withPanorama([listOk([liveInSyncEntry(fx)])], async (calls) => {
      await healthCheck(healthContext([fx.item]))

      assert.equal(mutatingCalls(calls).length, 0, 'a reachability probe must not write or commit')
    })
  })

  test(`${label} probes the configured device group, not shared`, async () => {
    await withPanorama([listOk([])], async (calls) => {
      const result = await healthCheck(healthContext([fx.item], { deviceGroup: 'DG-Branch' }))

      assert.equal(calls[0].location, 'device-group')
      assert.equal(calls[0].deviceGroup, 'DG-Branch')
      assert.match(result.checks[0].message, /DG-Branch/)
    })
  })

  test(`${label} reports reachable when the canvas declares nothing to check`, async () => {
    await withPanorama([listOk([])], async (calls) => {
      const result = await healthCheck(healthContext([]))

      assert.equal(calls.length, 1)
      assert.equal(result.checks.length, 1)
      assert.equal(result.healthy, true)
      assert.equal(result.score, 100)
    })
  })
}
