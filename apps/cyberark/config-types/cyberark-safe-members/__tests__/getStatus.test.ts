import getStatus from '../getStatus'
import { STATUS_COMPONENT, deploymentSummary, statusContext } from '../../lib/__tests__/fakePvwa'

const CONFIG_TYPE = 'cyberark-safe-members'

describe('CyberArk Safe Members Get Status Handler', () => {
  it('reports not deployed, and asks no further questions, when nothing has succeeded', async () => {
    const probe = statusContext(CONFIG_TYPE, { latest: null })

    const result = await getStatus(probe.ctx)

    expect(result.deployed).toBe(false)
    expect(result.version).toBe('7')
    expect(result.lastDeployedAt).toBe('')
    expect(result.componentStatuses).toHaveLength(0)
    // Only the deployment lookup — no component query for a canvas never deployed.
    expect(probe.deploymentQueries).toHaveLength(1)
    expect(probe.deploymentQueries[0].status).toBe('SUCCEEDED')
    expect(probe.componentQueries).toHaveLength(0)
  })

  it('reports the last successful deployment against every PVWA component', async () => {
    const probe = statusContext(CONFIG_TYPE, {
      latest: deploymentSummary(),
      components: [STATUS_COMPONENT],
    })

    const result = await getStatus(probe.ctx)

    expect(result.deployed).toBe(true)
    expect(result.version).toBe('7')
    expect(result.lastDeployedAt).toBe('2026-01-01T09:05:00.000Z')
    expect(result.componentStatuses).toHaveLength(1)
    expect(result.componentStatuses[0].componentId).toBe('comp-1')
    expect(result.componentStatuses[0].hostname).toBe('pvwa.example.com')
    expect(result.componentStatuses[0].healthScore).toBe(100)
    expect(result.componentStatuses[0].healthy).toBe(true)
    // Scoped to the PVWA component type, not every component in the tenant.
    expect(probe.componentQueries[0]).toEqual(['cyberark-pvwa'])
  })

  it('marks a component unhealthy below the 80 score threshold', async () => {
    const probe = statusContext(CONFIG_TYPE, {
      latest: deploymentSummary({ healthScore: 79 }),
      components: [STATUS_COMPONENT],
    })

    const result = await getStatus(probe.ctx)

    expect(result.componentStatuses[0].healthy).toBe(false)
    expect(result.componentStatuses[0].healthScore).toBe(79)
  })

  it('leaves health undefined rather than guessing when no score was recorded', async () => {
    const probe = statusContext(CONFIG_TYPE, {
      latest: deploymentSummary({ healthScore: null }),
      components: [STATUS_COMPONENT],
    })

    const result = await getStatus(probe.ctx)

    expect(result.componentStatuses[0].healthy).toBeUndefined()
    expect(result.componentStatuses[0].healthScore).toBeUndefined()
  })

  it('falls back to the start time when a deployment recorded no completion', async () => {
    const probe = statusContext(CONFIG_TYPE, {
      latest: deploymentSummary({ completedAt: null }),
      components: [STATUS_COMPONENT],
    })

    const result = await getStatus(probe.ctx)

    expect(result.lastDeployedAt).toBe('2026-01-01T09:00:00.000Z')
    expect(result.componentStatuses[0].lastDeployedAt).toBe('')
  })
})
