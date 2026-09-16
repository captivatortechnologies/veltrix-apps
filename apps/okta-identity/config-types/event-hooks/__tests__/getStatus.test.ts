// =============================================================================
// event-hooks — getStatus. It reports deployment state from the platform data
// API and must never reach the Okta org to do it.
// =============================================================================

import getStatus from '../getStatus'
import {
  FIXTURE_COMPONENT,
  priorDeployment,
  statusContext,
  withFetch,
} from '../../../lib/__tests__/fakeOkta'

describe('event-hooks getStatus', () => {
  it('reports not deployed when the canvas has no successful deployment', async () => {
    await withFetch([], async (calls) => {
      const result = await getStatus(statusContext())

      expect(result.deployed).toBe(false)
      expect(result.version).toBe('1')
      expect(result.lastDeployedAt).toBe('')
      expect(result.componentStatuses).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports the last successful deployment per component without calling Okta', async () => {
    await withFetch([], async (calls) => {
      const result = await getStatus(
        statusContext({ latestDeployment: priorDeployment({ 'item-1': 'eh1' }) }),
      )

      expect(result.deployed).toBe(true)
      expect(result.lastDeployedAt).toBe('2026-01-01T00:05:00.000Z')
      expect(result.componentStatuses).toHaveLength(1)
      expect(result.componentStatuses[0].componentId).toBe(FIXTURE_COMPONENT.id)
      expect(result.componentStatuses[0].hostname).toBe(FIXTURE_COMPONENT.hostname)
      expect(result.componentStatuses[0].deployed).toBe(true)
      expect(result.componentStatuses[0].healthy).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('marks a component unhealthy when the recorded health score is below 80', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}, { healthScore: 40 }) }),
    )

    expect(result.componentStatuses[0].healthy).toBe(false)
    expect(result.componentStatuses[0].healthScore).toBe(40)
  })

  it('treats exactly 80 as healthy — the threshold is inclusive', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}, { healthScore: 80 }) }),
    )

    expect(result.componentStatuses[0].healthy).toBe(true)
  })

  it('leaves health undefined when the deployment recorded no score', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}, { healthScore: null }) }),
    )

    expect(result.componentStatuses[0].healthy).toBeUndefined()
    expect(result.componentStatuses[0].healthScore).toBeUndefined()
  })

  it('falls back to startedAt when the deployment never recorded a completion time', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}, { completedAt: null }) }),
    )

    expect(result.deployed).toBe(true)
    expect(result.lastDeployedAt).toBe('2026-01-01T00:00:00.000Z')
    // The per-component field has no such fallback — it reports blank.
    expect(result.componentStatuses[0].lastDeployedAt).toBe('')
  })

  it('reports deployed with no component rows when the org component is gone', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}), components: [] }),
    )

    expect(result.deployed).toBe(true)
    expect(result.componentStatuses).toEqual([])
  })
})
