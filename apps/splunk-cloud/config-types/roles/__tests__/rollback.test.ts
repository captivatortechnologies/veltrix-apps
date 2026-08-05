import rollback from '../rollback'
import type { RollbackContext } from '@veltrixsecops/app-sdk'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
}

function captureFetch(status = 200): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Captured[] = []

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers as Record<string, string>) ?? {},
    })
    return { status, ok: status >= 200 && status < 300, text: async () => '{}' }
  }) as unknown as typeof fetch

  return { calls, restore: () => { globalThis.fetch = original } }
}

function makeCtx(rollbackData: unknown): RollbackContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Roles Canvas',
      toolType: 'splunk-cloud',
      entityType: 'roles',
      items: [],
      sections: [],
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'acme', port: '8089', type: ['splunk-cloud-stack'], toolId: 'splunk-cloud' },
    credential: {
      id: 'cred-1',
      name: 'Stack Credential',
      username: '',
      password: '',
      apiToken: 'STACK_JWT',
      certificate: null,
    },
    connectivity: null,
    connectivityProvider: null,
    rollbackData,
    targetVersion: {
      id: 'snap-0',
      canvasId: 'canvas-1',
      version: 0,
      name: 'Prior',
      toolType: 'splunk-cloud',
      entityType: 'roles',
      items: [],
      sections: [],
      snapshot: {},
    },
  }
}

describe('Splunk Cloud Roles rollback — legacy (pre-v1.12.0) REST rollbackData', () => {
  it('deletes a role the deploy created, from a flat legacy entry', async () => {
    const { calls, restore } = captureFetch()
    try {
      const result = await rollback(
        makeCtx({ previousState: [{ name: 'legacy-role', existed: false }] }),
      )
      expect(result.success).toBe(true)
      const deletes = calls.filter((c) => c.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(deletes[0].url).toBe('https://acme.splunkcloud.com:8089/services/authorization/roles/legacy-role')
    } finally {
      restore()
    }
  })

  it('restores a role the deploy updated, from a flat legacy entry with prior values', async () => {
    const { calls, restore } = captureFetch()
    try {
      const result = await rollback(
        makeCtx({
          previousState: [{ name: 'legacy-role', existed: true, prior: { capabilities: ['search'] } }],
        }),
      )
      expect(result.success).toBe(true)
      const posts = calls.filter((c) => c.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].url).toBe('https://acme.splunkcloud.com:8089/services/authorization/roles/legacy-role')
    } finally {
      restore()
    }
  })
})

describe('Splunk Cloud Roles rollback — ACS transport, per search-head target', () => {
  it('deletes a created role from EACH declared target', async () => {
    const { calls, restore } = captureFetch()
    try {
      const result = await rollback(
        makeCtx({
          previousState: [
            {
              name: 'modern-role',
              transport: 'acs',
              targets: [
                { target: 'sh-i-aaa', existed: false },
                { target: 'sh-i-bbb', existed: false },
              ],
            },
          ],
        }),
      )
      expect(result.success).toBe(true)
      const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url).sort()
      expect(deletes).toEqual([
        'https://admin.splunk.com/sh-i-aaa.acme/adminconfig/v2/roles/modern-role',
        'https://admin.splunk.com/sh-i-bbb.acme/adminconfig/v2/roles/modern-role',
      ])
    } finally {
      restore()
    }
  })

  it('restores an updated role at its one (untargeted) ACS default location', async () => {
    const { calls, restore } = captureFetch()
    try {
      const result = await rollback(
        makeCtx({
          previousState: [
            {
              name: 'modern-role',
              transport: 'acs',
              targets: [{ target: undefined, existed: true, prior: { capabilities: ['search'] } }],
            },
          ],
        }),
      )
      expect(result.success).toBe(true)
      const patches = calls.filter((c) => c.method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0].url).toBe('https://admin.splunk.com/acme/adminconfig/v2/roles/modern-role')
      expect(patches[0].headers['Federated-Search-Manage-Ack']).toBe('Y')
    } finally {
      restore()
    }
  })
})

describe('Splunk Cloud Roles rollback — error handling', () => {
  it('fails when there is no previous state', async () => {
    const result = await rollback(makeCtx({}))
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/no previous state/i)
  })

  it('fails when the previous state is an unrecognized shape', async () => {
    const result = await rollback(makeCtx({ previousState: [{ nope: true }] }))
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/unrecognized shape/i)
  })
})
