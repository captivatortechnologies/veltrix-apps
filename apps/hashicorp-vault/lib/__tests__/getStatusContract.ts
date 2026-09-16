// =============================================================================
// Shared `getStatus` contract for every Vault configuration type.
//
// All 17 getStatus handlers in this app are code-identical (they differ only in
// their doc comment): each asks the platform data API for the latest SUCCEEDED
// deployment of its canvas, then maps the customer's vault-cluster components
// onto that deployment. One contract suite, invoked from each config type's
// own __tests__ folder, asserts the whole behaviour without 17 copies of it.
//
// getStatus is the one handler that never touches Vault — it reads the platform
// data API — so it is driven with a recording stub of PlatformDataApi rather
// than the fetch harness.
// =============================================================================

import type {
  ComponentRef,
  ConfigStatus,
  DeploymentSummary,
  PipelineContext,
  PlatformDataApi,
} from '@veltrixsecops/app-sdk'
import { makeCanvas } from './vaultTestHarness'

type GetStatusHandler = (ctx: PipelineContext) => Promise<ConfigStatus>

interface PlatformRecorder {
  platform: PlatformDataApi
  deploymentQueries: Array<{ canvasId: string; status?: string }>
  componentQueries: Array<string[] | undefined>
}

function recordPlatform(
  deployment: DeploymentSummary | null,
  components: ComponentRef[] = [],
): PlatformRecorder {
  const deploymentQueries: Array<{ canvasId: string; status?: string }> = []
  const componentQueries: Array<string[] | undefined> = []
  return {
    deploymentQueries,
    componentQueries,
    platform: {
      getLatestDeployment: async (canvasId, opts) => {
        deploymentQueries.push({ canvasId, status: opts?.status })
        return deployment
      },
      listComponents: async (filter) => {
        componentQueries.push(filter?.types)
        return components
      },
    },
  }
}

function deploymentSummary(over: Partial<DeploymentSummary> = {}): DeploymentSummary {
  return {
    id: 'dep-1',
    canvasId: 'canvas-1',
    status: 'SUCCEEDED',
    healthScore: 95,
    startedAt: '2026-01-01T10:00:00Z',
    completedAt: '2026-01-01T10:05:00Z',
    environment: { id: 'env-1', name: 'production' },
    ...over,
  }
}

function component(id: string, hostname: string): ComponentRef {
  return { id, hostname, port: '8200', type: ['vault-cluster'], toolId: 'tool-1' }
}

function ctxWith(platform: PlatformDataApi, entityType: string): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: entityType,
    canvas: makeCanvas([], entityType),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform,
  }
}

/**
 * Register the getStatus contract suite for one configuration type.
 * `suiteName` matches the app's existing "Vault <Thing> <Handler> Handler" style.
 */
export function describeGetStatusContract(
  suiteName: string,
  getStatus: GetStatusHandler,
  entityType: string,
): void {
  describe(suiteName, () => {
    it('reports not deployed when no successful deployment exists', async () => {
      const rec = recordPlatform(null)

      const result = await getStatus(ctxWith(rec.platform, entityType))

      expect(result.deployed).toBe(false)
      expect(result.version).toBe('1')
      expect(result.lastDeployedAt).toBe('')
      expect(result.componentStatuses).toHaveLength(0)
      // No deployment means no reason to enumerate the customer's components.
      expect(rec.componentQueries).toHaveLength(0)
    })

    it('asks only for the SUCCEEDED deployment of its own canvas', async () => {
      const rec = recordPlatform(deploymentSummary())

      await getStatus(ctxWith(rec.platform, entityType))

      expect(rec.deploymentQueries).toEqual([{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
    })

    it('asks only for vault-cluster components', async () => {
      const rec = recordPlatform(deploymentSummary())

      await getStatus(ctxWith(rec.platform, entityType))

      expect(rec.componentQueries).toEqual([['vault-cluster']])
    })

    it('maps every component onto the deployment', async () => {
      const rec = recordPlatform(deploymentSummary(), [
        component('comp-1', 'vault-a.example.com'),
        component('comp-2', 'vault-b.example.com'),
      ])

      const result = await getStatus(ctxWith(rec.platform, entityType))

      expect(result.deployed).toBe(true)
      expect(result.lastDeployedAt).toBe('2026-01-01T10:05:00Z')
      expect(result.componentStatuses).toHaveLength(2)
      expect(result.componentStatuses[0].componentId).toBe('comp-1')
      expect(result.componentStatuses[0].hostname).toBe('vault-a.example.com')
      expect(result.componentStatuses[0].deployed).toBe(true)
      expect(result.componentStatuses[0].version).toBe('1')
      expect(result.componentStatuses[1].componentId).toBe('comp-2')
    })

    it('falls back to the start time when the deployment never recorded a completion', async () => {
      const rec = recordPlatform(deploymentSummary({ completedAt: null }), [
        component('comp-1', 'vault-a.example.com'),
      ])

      const result = await getStatus(ctxWith(rec.platform, entityType))

      expect(result.lastDeployedAt).toBe('2026-01-01T10:00:00Z')
      // The per-component field has no such fallback — it stays empty.
      expect(result.componentStatuses[0].lastDeployedAt).toBe('')
    })

    it('treats a health score of 80 as healthy and 79 as not', async () => {
      const healthy = recordPlatform(deploymentSummary({ healthScore: 80 }), [
        component('comp-1', 'vault-a.example.com'),
      ])
      const unhealthy = recordPlatform(deploymentSummary({ healthScore: 79 }), [
        component('comp-1', 'vault-a.example.com'),
      ])

      const healthyResult = await getStatus(ctxWith(healthy.platform, entityType))
      const unhealthyResult = await getStatus(ctxWith(unhealthy.platform, entityType))

      expect(healthyResult.componentStatuses[0].healthy).toBe(true)
      expect(healthyResult.componentStatuses[0].healthScore).toBe(80)
      expect(unhealthyResult.componentStatuses[0].healthy).toBe(false)
      expect(unhealthyResult.componentStatuses[0].healthScore).toBe(79)
    })

    it('leaves health unknown rather than guessing when no score was recorded', async () => {
      const rec = recordPlatform(deploymentSummary({ healthScore: null }), [
        component('comp-1', 'vault-a.example.com'),
      ])

      const result = await getStatus(ctxWith(rec.platform, entityType))

      // `false` here would read as "unhealthy" — an unscored deployment is neither.
      expect(result.componentStatuses[0].healthy).toBeUndefined()
      expect(result.componentStatuses[0].healthScore).toBeUndefined()
    })

    it('reports a zero health score as unhealthy rather than unknown', async () => {
      const rec = recordPlatform(deploymentSummary({ healthScore: 0 }), [
        component('comp-1', 'vault-a.example.com'),
      ])

      const result = await getStatus(ctxWith(rec.platform, entityType))

      expect(result.componentStatuses[0].healthy).toBe(false)
      expect(result.componentStatuses[0].healthScore).toBe(0)
    })

    it('reports deployed with no component statuses when the customer has no clusters', async () => {
      const rec = recordPlatform(deploymentSummary(), [])

      const result = await getStatus(ctxWith(rec.platform, entityType))

      expect(result.deployed).toBe(true)
      expect(result.componentStatuses).toHaveLength(0)
    })
  })
}
