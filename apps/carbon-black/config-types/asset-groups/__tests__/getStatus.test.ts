import getStatus from '../getStatus'
import { COMPLETED_AT, STARTED_AT, pipelineContext } from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'asset-groups'

function ctx(opts: Record<string, unknown> = {}) {
  return pipelineContext({ configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black asset-groups getStatus handler', () => {
  it('reports not deployed when the canvas has never been deployed', async () => {
    const result = await getStatus(ctx({ latestDeployment: null }))

    expect(result.deployed).toBe(false)
    expect(result.lastDeployedAt).toBe('')
    expect(result.componentStatuses).toHaveLength(1)
    expect(result.componentStatuses[0].deployed).toBe(false)
    // Omitted rather than empty-stringed, so the UI shows no date at all.
    expect(result.componentStatuses[0].lastDeployedAt).toBeUndefined()
  })

  it('reports deployed, dated by the deployment that succeeded', async () => {
    const result = await getStatus(ctx({ latestDeployment: {} }))

    expect(result.deployed).toBe(true)
    expect(result.lastDeployedAt).toBe(COMPLETED_AT)
    expect(result.componentStatuses[0].deployed).toBe(true)
    expect(result.componentStatuses[0].lastDeployedAt).toBe(COMPLETED_AT)
  })

  it('falls back to the start time when the deployment never recorded a completion', async () => {
    const result = await getStatus(ctx({ latestDeployment: { completedAt: null } }))

    expect(result.deployed).toBe(true)
    expect(result.lastDeployedAt).toBe(STARTED_AT)
  })

  it('reports not deployed rather than throwing when the platform is unavailable', async () => {
    // Status is best-effort: a platform read failure must not crash the pipeline.
    const result = await getStatus(ctx({ platformThrows: true }))

    expect(result.deployed).toBe(false)
    expect(result.lastDeployedAt).toBe('')
    expect(result.componentStatuses[0].deployed).toBe(false)
  })

  it('attributes the status to the component it deploys through', async () => {
    const result = await getStatus(ctx({ latestDeployment: {} }))

    expect(result.componentStatuses[0].componentId).toBe('comp-1')
    expect(result.componentStatuses[0].hostname).toBe('defense.conferdeploy.net')
  })

  it('reports no component statuses when the canvas has no component', async () => {
    const result = await getStatus(ctx({ latestDeployment: {}, noComponent: true }))

    expect(result.deployed).toBe(true)
    expect(result.componentStatuses).toHaveLength(0)
  })

  it('reports the canvas version as a string', async () => {
    const result = await getStatus(ctx({ latestDeployment: {} }))

    expect(result.version).toBe('1')
  })
})
