// =============================================================================
// The `getStatus` contract every FortiManager configuration type must satisfy.
//
// getStatus is the one handler that never touches FortiManager: it asks the
// platform for the latest SUCCEEDED deployment of this canvas and reports it
// against the component the config type deploys through. All 32 handlers are
// code-identical, so the contract lives here once and each config type's own
// `getStatus.test.ts` passes in ITS OWN module — the code under test is still
// per-config-type, only the expectations are shared.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { COMPLETED_AT, HOST, STARTED_AT, deploymentSummary, statusContext, withFmg } from './fakeFmg'
import type { ConfigFixture } from './configFixture'

type GetStatusHandler = (ctx: PipelineContext) => Promise<ConfigStatus>

/** Register the getStatus contract suite for one configuration type. */
export function describeGetStatusContract(fx: ConfigFixture, getStatus: GetStatusHandler): void {
  const label = `fortimanager ${fx.id} getStatus`

  test(`${label} reports not deployed when the canvas has never been deployed`, async () => {
    const probe = statusContext(fx.id, { latest: null })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, false)
    assert.equal(result.version, '4')
    assert.equal(result.lastDeployedAt, '')
    assert.equal(result.componentStatuses.length, 1)
    assert.equal(result.componentStatuses[0].deployed, false)
    assert.equal(result.componentStatuses[0].lastDeployedAt, undefined, 'never deployed has no date, not a blank one')
  })

  test(`${label} asks only for the SUCCEEDED deployment of its own canvas`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary() })

    await getStatus(probe.ctx)

    assert.deepEqual(probe.deploymentQueries, [{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
  })

  test(`${label} reports deployed, dated by the deployment that completed`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary() })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, true)
    assert.equal(result.lastDeployedAt, COMPLETED_AT)
    assert.equal(result.componentStatuses.length, 1)
    assert.equal(result.componentStatuses[0].componentId, 'comp-1')
    assert.equal(result.componentStatuses[0].hostname, HOST)
    assert.equal(result.componentStatuses[0].deployed, true)
    assert.equal(result.componentStatuses[0].lastDeployedAt, COMPLETED_AT)
  })

  test(`${label} falls back to the start time when the deployment never recorded a completion`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary({ completedAt: null }) })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, true)
    assert.equal(result.lastDeployedAt, STARTED_AT)
  })

  test(`${label} reports the canvas version it was asked about`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary(), version: 11 })

    const result = await getStatus(probe.ctx)

    assert.equal(result.version, '11')
  })

  test(`${label} reports no component statuses when the config type has no component`, async () => {
    const probe = statusContext(fx.id, { latest: deploymentSummary(), component: null })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, true)
    assert.deepEqual(result.componentStatuses, [])
  })

  test(`${label} absorbs an unreadable platform record rather than crashing the pipeline`, async () => {
    const probe = statusContext(fx.id, { latest: 'throws' })

    const result = await getStatus(probe.ctx)

    assert.equal(result.deployed, false)
    assert.equal(result.lastDeployedAt, '')
  })

  test(`${label} never reaches FortiManager`, async () => {
    await withFmg([], async (calls) => {
      const probe = statusContext(fx.id, { latest: deploymentSummary() })

      await getStatus(probe.ctx)

      assert.equal(calls.length, 0, 'status is read from platform records, not from the customer’s FortiManager')
    })
  })
}
