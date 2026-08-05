import deploy from '../deploy'
import { __setSplunkTransport } from '../../../lib/splunkApi'
import type { CanvasItemSnapshot, DeployContext } from '@veltrixsecops/app-sdk'

// =============================================================================
// License Pool deploy — create, edit, and stack-change (recreate) paths.
// =============================================================================

interface RecordedCall {
  url: string
  method: string
}

let calls: RecordedCall[] = []

function makeCtx(fields: Record<string, unknown>): DeployContext {
  const item: CanvasItemSnapshot = { name: 'item-1', fields }
  const sections = [item]
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'license-pools',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'License Pools',
      toolType: 'splunk-enterprise',
      entityType: 'license-pools',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'splunk-license.babong.local', port: '8089', type: ['license-server'], toolId: 'splunk' },
    credential: { id: 'cred-1', name: 'svc', username: 'admin', password: 'pw', apiToken: null, certificate: null },
    connectivity: {
      id: 'conn-1',
      status: 'CONNECTED',
      sshCommand: null,
      httpsUrl: 'https://splunk-license.babong.local:8089',
      tailscaleDeviceIP: null,
    },
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  }
}

const POOLS_PATH = '/services/licenser/pools'
const created = () => calls.some((c) => c.method === 'POST' && c.url.endsWith(POOLS_PATH))

describe('License Pool deploy', () => {
  it('creates a pool that does not exist yet', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'GET') return { ok: false, status: 404, text: async () => 'not found' }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB', peers: '*' }))

    expect(result.success).toBe(true)
    expect(created()).toBe(true)
    expect((result.rollbackData as { createdPools?: string[] })?.createdPools).toContain('prod-pool')
  })

  it('edits an existing pool in place (no stack change)', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ entry: [{ content: { stack_id: 'Enterprise', quota: '536870912000', peers: '*', description: 'old' } }] }),
        }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '600GB', peers: '*' }))

    expect(result.success).toBe(true)
    expect(created()).toBe(false) // no create POST — it already existed
    const editCall = calls.find((c) => c.method === 'POST' && c.url.includes(`${POOLS_PATH}/prod-pool`))
    expect(editCall).toBeDefined()
    // No DELETE — the stack did not change.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('recreates the pool when the declared stack differs from the live stack', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'GET') {
        if (calls.filter((c) => c.method === 'GET').length === 1) {
          // First GET: existing pool on the OLD stack.
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ entry: [{ content: { stack_id: 'Free', quota: '1000', peers: '*' } }] }),
          }
        }
        // Second GET (post-recreate final read): report the NEW stack.
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ entry: [{ content: { stack_id: 'Enterprise', quota: '536870912000', peers: '*' } }] }),
        }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ name: 'moved-pool', stackId: 'Enterprise', quota: '500GB', peers: '*' }))

    expect(result.success).toBe(true)
    expect(result.message).toContain('Recreated')
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes(`${POOLS_PATH}/moved-pool`))).toBe(true)
    expect(created()).toBe(true) // recreated via the collection POST
  })

  it('fails clearly when the pool cannot be deleted to move stacks', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ entry: [{ content: { stack_id: 'Free', quota: '1000', peers: '*' } }] }),
        }
      }
      if (method === 'DELETE') return { ok: false, status: 409, text: async () => 'fixed pool' }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ name: 'fixed-pool', stackId: 'Enterprise', quota: '500GB', peers: '*' }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('could not be moved')
  })

  it('captures the deployed pool state as a resource for the View modal', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              entry: [{ content: { stack_id: 'Enterprise', quota: '536870912000', used_bytes: '1024', peers: '*', description: 'prod' } }],
            }),
        }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ name: 'prod-pool', stackId: 'Enterprise', quota: '500GB', peers: '*' }))
    expect(result.success).toBe(true)

    const resources = (result.artifacts as { resources?: Array<{ name: string; fields: Array<{ label: string; value: string }> }> })?.resources ?? []
    expect(resources.length).toBe(1)
    expect(resources[0].name).toContain('prod-pool')
    const quotaField = resources[0].fields.find((f) => f.label === 'Quota (bytes)')
    expect(quotaField?.value).toBe('536870912000')
  })
})
