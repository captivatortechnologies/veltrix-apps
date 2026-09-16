// =============================================================================
// Shared `getStatus` contract for every Keycloak configuration type.
//
// All 16 getStatus handlers are code-identical (lib/status.ts, which
// `clients/getStatus.ts` inlines verbatim): ask the platform data API for the
// latest SUCCEEDED deployment of this canvas, then map the customer's Keycloak
// components onto it. One contract suite, invoked from each config type's own
// __tests__ folder, asserts the whole behaviour without 16 copies of it.
//
// getStatus is the one handler that never touches Keycloak — it reads platform
// records — so it is driven with a recording stub of PlatformDataApi rather
// than the node:https harness.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  ComponentRef,
  ConfigStatus,
  DeploymentSummary,
  PipelineContext,
  PlatformDataApi,
} from '@veltrixsecops/app-sdk'
import { canvas } from './fakeKeycloak'

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
  const deploymentQueries: PlatformRecorder['deploymentQueries'] = []
  const componentQueries: PlatformRecorder['componentQueries'] = []
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

function realmComponent(id: string, hostname: string): ComponentRef {
  return { id, hostname, port: '443', type: ['keycloak-realm'], toolId: 'keycloak' }
}

function ctxWith(platform: PlatformDataApi, entityType: string): PipelineContext {
  return {
    appId: 'keycloak',
    customerId: 'cust-1',
    configTypeId: entityType,
    canvas: { ...canvas([], entityType), version: 7 },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform,
  } as unknown as PipelineContext
}

/** Register the getStatus contract suite for one configuration type. */
export function describeGetStatusContract(label: string, getStatus: GetStatusHandler, entityType: string): void {
  test(`${label} getStatus reports not deployed when no successful deployment exists`, async () => {
    const rec = recordPlatform(null)

    const result = await getStatus(ctxWith(rec.platform, entityType))

    assert.equal(result.deployed, false)
    assert.equal(result.version, '7')
    assert.equal(result.lastDeployedAt, '')
    assert.deepEqual(result.componentStatuses, [])
    // No deployment means no reason to enumerate the customer's components.
    assert.equal(rec.componentQueries.length, 0)
  })

  test(`${label} getStatus asks only for the SUCCEEDED deployment of its own canvas`, async () => {
    const rec = recordPlatform(deploymentSummary())

    await getStatus(ctxWith(rec.platform, entityType))

    assert.deepEqual(rec.deploymentQueries, [{ canvasId: 'canvas-1', status: 'SUCCEEDED' }])
  })

  test(`${label} getStatus asks only for this app's own component types`, async () => {
    const rec = recordPlatform(deploymentSummary())

    await getStatus(ctxWith(rec.platform, entityType))

    assert.deepEqual(rec.componentQueries, [['keycloak-realm', 'standalone']])
  })

  test(`${label} getStatus maps every component onto the deployment`, async () => {
    const rec = recordPlatform(deploymentSummary(), [
      realmComponent('comp-1', 'kc-a.example.com'),
      realmComponent('comp-2', 'kc-b.example.com'),
    ])

    const result = await getStatus(ctxWith(rec.platform, entityType))

    assert.equal(result.deployed, true)
    assert.equal(result.lastDeployedAt, '2026-01-01T10:05:00Z')
    assert.equal(result.componentStatuses.length, 2)
    assert.equal(result.componentStatuses[0].componentId, 'comp-1')
    assert.equal(result.componentStatuses[0].hostname, 'kc-a.example.com')
    assert.equal(result.componentStatuses[0].deployed, true)
    assert.equal(result.componentStatuses[0].version, '7')
    assert.equal(result.componentStatuses[1].componentId, 'comp-2')
  })

  test(`${label} getStatus falls back to the start time when the deployment never completed`, async () => {
    const rec = recordPlatform(deploymentSummary({ completedAt: null }), [
      realmComponent('comp-1', 'kc-a.example.com'),
    ])

    const result = await getStatus(ctxWith(rec.platform, entityType))

    assert.equal(result.lastDeployedAt, '2026-01-01T10:00:00Z')
    // The per-component field has no such fallback — it stays empty.
    assert.equal(result.componentStatuses[0].lastDeployedAt, '')
  })

  test(`${label} getStatus treats a health score of 80 as healthy and 79 as not`, async () => {
    const healthy = recordPlatform(deploymentSummary({ healthScore: 80 }), [
      realmComponent('comp-1', 'kc-a.example.com'),
    ])
    const unhealthy = recordPlatform(deploymentSummary({ healthScore: 79 }), [
      realmComponent('comp-1', 'kc-a.example.com'),
    ])

    const healthyResult = await getStatus(ctxWith(healthy.platform, entityType))
    const unhealthyResult = await getStatus(ctxWith(unhealthy.platform, entityType))

    assert.equal(healthyResult.componentStatuses[0].healthy, true)
    assert.equal(healthyResult.componentStatuses[0].healthScore, 80)
    assert.equal(unhealthyResult.componentStatuses[0].healthy, false)
    assert.equal(unhealthyResult.componentStatuses[0].healthScore, 79)
  })

  test(`${label} getStatus leaves health unknown rather than guessing when no score was recorded`, async () => {
    const rec = recordPlatform(deploymentSummary({ healthScore: null }), [
      realmComponent('comp-1', 'kc-a.example.com'),
    ])

    const result = await getStatus(ctxWith(rec.platform, entityType))

    // `false` here would read as "unhealthy" — an unscored deployment is neither.
    assert.equal(result.componentStatuses[0].healthy, undefined)
    assert.equal(result.componentStatuses[0].healthScore, undefined)
  })

  test(`${label} getStatus reports a score of zero as unhealthy, not as unknown`, async () => {
    const rec = recordPlatform(deploymentSummary({ healthScore: 0 }), [
      realmComponent('comp-1', 'kc-a.example.com'),
    ])

    const result = await getStatus(ctxWith(rec.platform, entityType))

    // A falsy check here reported the worst possible score as "never scored",
    // which is the one state an operator does not need to act on.
    assert.equal(result.componentStatuses[0].healthy, false)
    assert.equal(result.componentStatuses[0].healthScore, 0)
  })

  test(`${label} getStatus reports deployed with no component statuses when the customer has none`, async () => {
    const rec = recordPlatform(deploymentSummary(), [])

    const result = await getStatus(ctxWith(rec.platform, entityType))

    assert.equal(result.deployed, true)
    assert.deepEqual(result.componentStatuses, [])
  })
}
