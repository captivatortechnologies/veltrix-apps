// =============================================================================
// Status handler tests.
//
// getStatus is the only one of the six handlers that never calls Defender: it
// answers from platform data alone. All five defender config types that report
// status share this one implementation (lib/indicators.ts).
// =============================================================================

import getStatus from '../getStatus'
import type { ComponentRef, DeploymentSummary, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { statusCtx } from '../../../lib/__tests__/mdeFakeApi'

const TYPE = 'mde-file-indicators'

const tenantComponent: ComponentRef = {
  id: 'comp-1',
  hostname: 'api.security.microsoft.com',
  port: '443',
  type: ['mde-tenant'],
  toolId: 'defender-endpoint',
}

function deployment(overrides: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id: 'dep-1',
    canvasId: 'canvas-1',
    status: 'SUCCEEDED',
    healthScore: 95,
    startedAt: '2026-03-01T09:00:00Z',
    completedAt: '2026-03-01T09:05:00Z',
    environment: { id: 'env-1', name: 'production' },
    ...overrides,
  }
}

/** Records what the handler asked the platform for, so the query itself is testable. */
function recordingPlatform(latest: DeploymentSummary | null, components: ComponentRef[]) {
  const asked: { canvasId?: string; status?: string; types?: string[] } = {}
  const platform: PlatformDataApi = {
    getLatestDeployment: async (canvasId, opts) => {
      asked.canvasId = canvasId
      asked.status = opts?.status
      return latest
    },
    listComponents: async (filter) => {
      asked.types = filter?.types
      return components
    },
  }
  return { platform, asked }
}

describe('Defender File Indicators Status Handler', () => {
  it('reports not deployed when no deployment has ever succeeded', async () => {
    const { platform } = recordingPlatform(null, [tenantComponent])
    const result = await getStatus(statusCtx(TYPE, { platform }))

    expect(result.deployed).toBe(false)
    expect(result.version).toBe('1')
    expect(result.lastDeployedAt).toBe('')
    expect(result.componentStatuses).toHaveLength(0)
  })

  it('asks only for SUCCEEDED deployments of this canvas, and only for mde-tenant components', async () => {
    const { platform, asked } = recordingPlatform(deployment(), [tenantComponent])
    await getStatus(statusCtx(TYPE, { platform }))

    expect(asked.canvasId).toBe('canvas-1')
    expect(asked.status).toBe('SUCCEEDED')
    expect(asked.types).toEqual(['mde-tenant'])
  })

  it('reports each tenant component with the deployment health', async () => {
    const { platform } = recordingPlatform(deployment(), [tenantComponent])
    const result = await getStatus(statusCtx(TYPE, { platform }))

    expect(result.deployed).toBe(true)
    expect(result.lastDeployedAt).toBe('2026-03-01T09:05:00Z')
    expect(result.componentStatuses).toHaveLength(1)
    expect(result.componentStatuses[0].componentId).toBe('comp-1')
    expect(result.componentStatuses[0].hostname).toBe('api.security.microsoft.com')
    expect(result.componentStatuses[0].healthScore).toBe(95)
    expect(result.componentStatuses[0].healthy).toBe(true)
  })

  it('treats a health score below 80 as unhealthy', async () => {
    const { platform } = recordingPlatform(deployment({ healthScore: 79 }), [tenantComponent])
    const result = await getStatus(statusCtx(TYPE, { platform }))

    expect(result.componentStatuses[0].healthy).toBe(false)
  })

  it('leaves health unknown rather than guessing when the deployment carries no score', async () => {
    const { platform } = recordingPlatform(deployment({ healthScore: null }), [tenantComponent])
    const result = await getStatus(statusCtx(TYPE, { platform }))

    expect(result.componentStatuses[0].healthy).toBeUndefined()
    expect(result.componentStatuses[0].healthScore).toBeUndefined()
  })

  it('falls back to the start time when a succeeded deployment has no completion time', async () => {
    const { platform } = recordingPlatform(deployment({ completedAt: null }), [tenantComponent])
    const result = await getStatus(statusCtx(TYPE, { platform }))

    expect(result.lastDeployedAt).toBe('2026-03-01T09:00:00Z')
    expect(result.componentStatuses[0].lastDeployedAt).toBe('')
  })
})
