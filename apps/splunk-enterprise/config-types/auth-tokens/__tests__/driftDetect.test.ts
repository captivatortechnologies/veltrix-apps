import driftDetect from '../driftDetect'
import { __setSplunkTransport } from '../../../lib/splunkApi'
import type { CanvasItemSnapshot, DriftContext } from '@veltrixsecops/app-sdk'

function makeCtx(fields: Record<string, unknown>): DriftContext {
  const item: CanvasItemSnapshot = { name: 'item-1', fields }
  const sections = [item]
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'auth-tokens',
    canvas: {
      id: 'snap-1', canvasId: 'canvas-1', version: 1, name: 'API Access Tokens',
      toolType: 'splunk-enterprise', entityType: 'auth-tokens', items: sections, sections, snapshot: {},
    },
    deployedConfig: {
      id: 'snap-1', canvasId: 'canvas-1', version: 1, name: 'API Access Tokens',
      toolType: 'splunk-enterprise', entityType: 'auth-tokens', items: sections, sections, snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'splunk-sh1.babong.local', port: '8089', type: ['search-head'], toolId: 'splunk' },
    credential: { id: 'cred-1', name: 'svc', username: 'admin', password: 'pw', apiToken: null, certificate: null },
    connectivity: { id: 'conn-1', status: 'CONNECTED', sshCommand: null, httpsUrl: 'https://splunk-sh1.babong.local:8089', tailscaleDeviceIP: null },
    connectivityProvider: null,
  }
}

function stubList(entries: Array<Record<string, unknown>> | null, status = 200): void {
  __setSplunkTransport(async (url) => {
    if (url.includes('/jobs/export')) return { ok: false, status: 404, text: async () => '' }
    if (entries === null) return { ok: false, status, text: async () => 'error' }
    return { ok: true, status: 200, text: async () => JSON.stringify({ entry: entries.map((content) => ({ content })) }) }
  })
}

describe('API Access Token driftDetect', () => {
  it('reports no drift when the live token matches the canvas', async () => {
    stubList([{ audience: 'automation', type: 'static', status: 'enabled' }])
    const result = await driftDetect(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: true }))
    expect(result.hasDrift).toBe(false)
  })

  it('flags a missing token as critical', async () => {
    stubList([])
    const result = await driftDetect(makeCtx({ username: 'svc1', audience: 'automation' }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.severity === 'critical' && d.actual === 'missing')).toBe(true)
  })

  it('flags a disabled token as critical when enabled is expected', async () => {
    stubList([{ audience: 'automation', type: 'static', status: 'disabled' }])
    const result = await driftDetect(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: true }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.field.endsWith('.enabled') && d.severity === 'critical')).toBe(true)
  })

  it('flags an enabled token as a warning when disabled is expected', async () => {
    stubList([{ audience: 'automation', type: 'static', status: 'enabled' }])
    const result = await driftDetect(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: false }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.field.endsWith('.enabled') && d.severity === 'warning')).toBe(true)
  })

  it('flags a type change as a warning', async () => {
    stubList([{ audience: 'automation', type: 'ephemeral', status: 'enabled' }])
    const result = await driftDetect(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: true }))
    expect(result.hasDrift).toBe(true)
    expect(result.diffs.some((d) => d.field.endsWith('.tokenType') && d.severity === 'warning')).toBe(true)
  })
})
