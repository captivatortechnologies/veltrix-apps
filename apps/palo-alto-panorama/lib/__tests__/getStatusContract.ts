// =============================================================================
// The `getStatus` contract every Panorama configuration type must satisfy.
//
// getStatus is the one handler that never touches Panorama: it asks the platform
// for the latest SUCCEEDED deployment of this canvas and reports it against the
// customer's Panorama components. All 23 handlers are code-identical, so the
// contract lives here once and each config type's own `getStatus.test.ts` passes
// in ITS OWN module — the code under test is still per-configuration-type, only
// the expectations are shared.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { COMPLETED_AT, COMPONENT, HOST, STARTED_AT, deploymentSummary, statusContext, withPanorama } from './fakePanorama'
import type { ConfigFixture } from './configFixture'

type GetStatusHandler = (ctx: PipelineContext) => Promise<ConfigStatus>

/** Register the getStatus contract suite for one configuration type. */
export function describeGetStatusContract(fx: ConfigFixture, getStatus: GetStatusHandler): void {
  const label = `panorama ${fx.id} getStatus`

  test(`${label} reports not deployed when the canvas has never been deployed`, async () => {
    const probe = statusContext(fx.id, { latest: null })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, false)
    assert.equal(result.version, '4')
    assert.equal(result.lastDeployedAt, '')
    assert.deepEqual(result.componentStatuses, [])
    assert.equal(probe.componentQueries.length, 0, 'nothing was deployed, so there is nothing to ask about')
  })

  test(`${label} asks only for the SUCCEEDED deployment of its own canvas`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary() })

    await getStatus(probe.ctx)

    assert.deepEqual(probe.deploymentQueries, [{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
  })

  test(`${label} asks the platform only for Panorama components`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary() })

    await getStatus(probe.ctx)

    assert.deepEqual(probe.componentQueries, [{ types: ['panorama'] }])
  })

  test(`${label} reports deployed, dated by the deployment that completed`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary() })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, true)
    assert.equal(result.lastDeployedAt, COMPLETED_AT)
    assert.equal(result.componentStatuses.length, 1)
    assert.equal(result.componentStatuses[0].componentId, COMPONENT.id)
    assert.equal(result.componentStatuses[0].hostname, HOST)
    assert.equal(result.componentStatuses[0].deployed, true)
    assert.equal(result.componentStatuses[0].lastDeployedAt, COMPLETED_AT)
  })

  test(`${label} falls back to the start time when the deployment never recorded a completion`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary({ completedAt: null }) })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, true)
    assert.equal(result.lastDeployedAt, STARTED_AT)
    assert.equal(result.componentStatuses[0].lastDeployedAt, '')
  })

  test(`${label} reports the canvas version it was asked about`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary(), version: 11 })

    const result = await getStatus(probe.ctx)

    assert.equal(result.version, '11')
    assert.equal(result.componentStatuses[0].version, '11')
  })

  test(`${label} carries the health score through and calls 80 healthy`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary({ healthScore: 80 }) })

    const result = await getStatus(probe.ctx)

    assert.equal(result.componentStatuses[0].healthScore, 80)
    assert.equal(result.componentStatuses[0].healthy, true)
  })

  test(`${label} calls a deployment below 80 unhealthy`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary({ healthScore: 50 }) })

    const result = await getStatus(probe.ctx)

    assert.equal(result.componentStatuses[0].healthScore, 50)
    assert.equal(result.componentStatuses[0].healthy, false)
  })

  test(`${label} leaves health unknown when the deployment recorded no score`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary({ healthScore: null }) })

    const result = await getStatus(probe.ctx)

    assert.equal(result.componentStatuses[0].healthy, undefined, 'no score is "unknown", not "unhealthy"')
    assert.equal(result.componentStatuses[0].healthScore, undefined)
  })

  test(`${label} reports no component statuses when the customer has no Panorama registered`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary(), components: [] })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, true)
    assert.deepEqual(result.componentStatuses, [])
  })

  test(`${label} never reaches Panorama`, async () => {
    await withPanorama([], async (calls) => {
      const probe = statusContext(fx.id, { latest: deploymentSummary() })

      await getStatus(probe.ctx)

      assert.equal(calls.length, 0, 'status is read from platform records, not from the customer’s Panorama')
    })
  })
}
