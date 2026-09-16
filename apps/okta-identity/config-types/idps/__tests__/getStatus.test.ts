// =============================================================================
// idps — getStatus. It reports deployment state from the platform data API
// and must never reach the Okta org to do it.
// =============================================================================

import getStatus from '../getStatus'
import {
  FIXTURE_COMPONENT,
  priorDeployment,
  statusContext,
  withFetch,
} from '../../../lib/__tests__/fakeOkta'

describe('idps getStatus', () => {
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
        statusContext({ latestDeployment: priorDeployment({ 'item-1': 'obj-1' }) }),
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

  it('treats a score of exactly 80 as healthy — the threshold is inclusive', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}, { healthScore: 80 }) }),
    )

    expect(result.componentStatuses[0].healthy).toBe(true)
  })

  it('marks a component unhealthy when the recorded health score is below 80', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}, { healthScore: 79 }) }),
    )

    expect(result.componentStatuses[0].healthy).toBe(false)
    expect(result.componentStatuses[0].healthScore).toBe(79)
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
    expect(result.componentStatuses[0].lastDeployedAt).toBe('')
  })

  it('reports one status row per registered org component', async () => {
    const result = await getStatus(
      statusContext({
        latestDeployment: priorDeployment({}),
        components: [
          { ...FIXTURE_COMPONENT, id: 'comp-a', hostname: 'a.okta.com' },
          { ...FIXTURE_COMPONENT, id: 'comp-b', hostname: 'b.okta.com' },
        ],
      }),
    )

    expect(result.componentStatuses).toHaveLength(2)
    expect(result.componentStatuses[1].hostname).toBe('b.okta.com')
  })

  it('reports deployed with no component rows when no org component is registered', async () => {
    const result = await getStatus(
      statusContext({ latestDeployment: priorDeployment({}), components: [] }),
    )

    expect(result.deployed).toBe(true)
    expect(result.componentStatuses).toEqual([])
  })
})
