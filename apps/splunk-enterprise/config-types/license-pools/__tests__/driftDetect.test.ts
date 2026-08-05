import driftDetect from '../driftDetect'
import { __setSplunkTransport } from '../../../lib/splunkApi'
import type { CanvasItemSnapshot, DriftContext } from '@veltrixsecops/app-sdk'

function makeCtx(fields: Record<string, unknown>): DriftContext {
  const item: CanvasItemSnapshot = { name: 'item-1', fields }
  const sections = [item]
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'license-pools',
    canvas: {
      id: 'snap-1', canvasId: 'canvas-1', version: 1, name: 'License Pools',
      toolType: 'splunk-enterprise', entityType: 'license-pools', items: sections, sections, snapshot: {},
    },
    deployedConfig: {
      id: 'snap-1', canvasId: 'canvas-1', version: 1, name: 'License Pools',
      toolType: 'splunk-enterprise', entityType: 'license-pools', items: sections, sections, snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'splunk-license.babong.local', port: '8089', type: ['license-server'], toolId: 'splunk' },
    credential: { id: 'cred-1', name: 'svc', username: 'admin', password: 'pw', apiToken: null, certificate: null },
    connectivity: { id: 'conn-1', status: 'CONNECTED', sshCommand: null, httpsUrl: 'https://splunk-license.babong.local:8089', tailscaleDeviceIP: null },
    connectivityProvider: null,
  }
}

function stubGet(content: Record<string, unknown> | null, status = 200): void {
  __setSplunkTransport(async (url) => {
    // The audit-attribution search export always no-ops here (best-effort).
    if (url.includes('/jobs/export')) return { ok: false, status: 404, text: async () => '' }
    if (content === null) return { ok: false, status, text: async () => 'not found' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ entry: [{ content }] }) }
  })
}

describe('License Pool driftDetect', () => {
  it('reports no drift when live state matches the canvas', async () => {
    stubGet({ stack_id: 'Enterprise', quota: '536870912000', peers: '*', description: 'prod' })
    const result = await driftDetect(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB', peers: '*', description: 'prod' }))
    expect(result.hasDrift).toBe(false)
  })

  it('flags a missing pool as critical', async () => {
    stubGet(null, 404)
    const result = await driftDetect(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB' }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.severity === 'critical' && d.actual === 'missing')).toBe(true)
  })

  it('flags a stack mismatch as critical', async () => {
    stubGet({ stack_id: 'Free', quota: '536870912000', peers: '*' })
    const result = await driftDetect(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB' }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.field === 'prod-pool.stackId' && d.severity === 'critical')).toBe(true)
  })

  it('flags a quota change beyond tolerance as a warning', async () => {
    stubGet({ stack_id: 'Enterprise', quota: '107374182400', peers: '*' }) // 100GB live vs 500GB declared
    const result = await driftDetect(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB' }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.field === 'prod-pool.quota' && d.severity === 'warning')).toBe(true)
  })

  it('does not flag quota within the rounding tolerance', async () => {
    stubGet({ stack_id: 'Enterprise', quota: String(500 * 1024 ** 3 + 1000), peers: '*' }) // negligible delta
    const result = await driftDetect(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB' }))
    expect(result.hasDrift).toBe(false)
  })

  it('flags a peers change as a warning', async () => {
    stubGet({ stack_id: 'Enterprise', quota: '536870912000', peers: 'OTHER-PEER' })
    const result = await driftDetect(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB', peers: 'MY-PEER' }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.field === 'prod-pool.peers' && d.severity === 'warning')).toBe(true)
  })
})
