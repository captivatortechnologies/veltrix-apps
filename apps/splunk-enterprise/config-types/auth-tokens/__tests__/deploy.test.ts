import deploy from '../deploy'
import { __setSplunkTransport } from '../../../lib/splunkApi'
import type { CanvasItemSnapshot, DeployContext } from '@veltrixsecops/app-sdk'

// =============================================================================
// API Access Token deploy — create, status-reconcile, and
// immutable-field-drift (delete + recreate) paths.
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
    configTypeId: 'auth-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'API Access Tokens',
      toolType: 'splunk-enterprise',
      entityType: 'auth-tokens',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'splunk-sh1.babong.local', port: '8089', type: ['search-head'], toolId: 'splunk' },
    credential: { id: 'cred-1', name: 'svc', username: 'admin', password: 'pw', apiToken: null, certificate: null },
    connectivity: {
      id: 'conn-1',
      status: 'CONNECTED',
      sshCommand: null,
      httpsUrl: 'https://splunk-sh1.babong.local:8089',
      tailscaleDeviceIP: null,
    },
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  }
}

const TOKENS_PATH = '/services/authorization/tokens'
const ENABLE_PATH = '/services/admin/token-auth/tokens_auth'

describe('API Access Token deploy', () => {
  it('creates a token when none exists for the (username, audience) pair', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.includes(ENABLE_PATH)) return { ok: true, status: 200, text: async () => '{}' }
      if (method === 'GET' && url.includes(TOKENS_PATH)) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ entry: [] }) }
      }
      if (method === 'POST' && url.endsWith(TOKENS_PATH)) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ entry: [{ content: { id: 'tok-1', token: 'SPLUNK-SECRET-VALUE', audience: 'automation' } }] }),
        }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: true }))

    expect(result.success).toBe(true)
    const resources = (result.artifacts as { resources?: Array<{ fields: Array<{ label: string; value: string; secret?: boolean }> }> })?.resources ?? []
    expect(resources.length).toBe(1)
    const tokenField = resources[0].fields.find((f) => f.label === 'Token')
    expect(tokenField?.value).toBe('SPLUNK-SECRET-VALUE')
    expect(tokenField?.secret).toBe(true)
  })

  it('reconciles status on a pre-existing token without recreating it', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.includes(ENABLE_PATH)) return { ok: true, status: 200, text: async () => '{}' }
      if (method === 'GET' && url.includes(TOKENS_PATH)) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ entry: [{ content: { id: 'tok-1', audience: 'automation', type: 'static', status: 'enabled' } }] }),
        }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: false }))

    expect(result.success).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    const statusCall = calls.find((c) => c.method === 'POST' && c.url.includes(`${TOKENS_PATH}/svc1`))
    expect(statusCall).toBeDefined()
    // No token value to show — it already existed.
    const resources = (result.artifacts as { resources?: Array<{ fields: Array<{ label: string; value: string; secret?: boolean }> }> })?.resources ?? []
    const tokenField = resources[0].fields.find((f) => f.label === 'Token')
    expect(tokenField?.secret).toBe(false)
  })

  it('deletes and recreates the token when an immutable field (type) drifted', async () => {
    calls = []
    let listCallCount = 0
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.includes(ENABLE_PATH)) return { ok: true, status: 200, text: async () => '{}' }
      if (method === 'GET' && url.includes(TOKENS_PATH)) {
        listCallCount++
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ entry: [{ content: { id: 'tok-old', audience: 'automation', type: 'ephemeral', status: 'enabled' } }] }),
        }
      }
      if (method === 'DELETE') return { ok: true, status: 200, text: async () => '{}' }
      if (method === 'POST' && url.endsWith(TOKENS_PATH)) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ entry: [{ content: { id: 'tok-new', token: 'NEW-SECRET', audience: 'automation' } }] }),
        }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ username: 'svc1', audience: 'automation', tokenType: 'static', enabled: true }))

    expect(result.success).toBe(true)
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes(`${TOKENS_PATH}/svc1`))).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(TOKENS_PATH))).toBe(true)
    expect(listCallCount).toBe(1)
    const resources = (result.artifacts as { resources?: Array<{ fields: Array<{ label: string; value: string }> }> })?.resources ?? []
    expect(resources[0].fields.find((f) => f.label === 'Token')?.value).toBe('NEW-SECRET')
  })

  it('enables Token Authentication before creating tokens', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'GET' && url.includes(TOKENS_PATH)) return { ok: true, status: 200, text: async () => JSON.stringify({ entry: [] }) }
      if (method === 'POST' && url.endsWith(TOKENS_PATH)) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ entry: [{ content: { id: 'tok-1', token: 'X' } }] }) }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ username: 'svc1', audience: 'automation' }))
    expect(result.success).toBe(true)
    expect(calls.some((c) => c.method === 'POST' && c.url.includes(ENABLE_PATH))).toBe(true)
  })

  it('still succeeds but warns when Token Authentication cannot be enabled', async () => {
    calls = []
    __setSplunkTransport(async (url, init) => {
      const method = init.method ?? 'GET'
      calls.push({ url, method })
      if (method === 'POST' && url.includes(ENABLE_PATH)) return { ok: false, status: 403, text: async () => 'denied' }
      if (method === 'GET' && url.includes(TOKENS_PATH)) return { ok: true, status: 200, text: async () => JSON.stringify({ entry: [] }) }
      if (method === 'POST' && url.endsWith(TOKENS_PATH)) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ entry: [{ content: { id: 'tok-1', token: 'X' } }] }) }
      }
      return { ok: true, status: 200, text: async () => '{}' }
    })

    const result = await deploy(makeCtx({ username: 'svc1', audience: 'automation' }))
    expect(result.success).toBe(true)
    expect(result.message).toContain('WARNING')
    expect(result.message).toContain('Token Authentication')
  })
})
