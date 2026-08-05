import healthCheck from '../healthCheck'
import type { CanvasItemSnapshot, HealthCheckContext } from '@veltrixsecops/app-sdk'

function captureFetch(handler: (url: string) => { status: number; body: unknown }): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const { status, body } = handler(String(url))
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

function makeCtx(items: CanvasItemSnapshot[], credentialOverrides: Partial<{ apiToken: string | null; password: string }> = {}): HealthCheckContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: { id: 'c', canvasId: 'canvas-1', version: 1, name: 'n', toolType: 'splunk-cloud', entityType: 'roles', items, sections: items, snapshot: {} },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'acme', port: '8089', type: ['splunk-cloud-stack'], toolId: 'splunk-cloud' },
    credential: {
      id: 'cred-1',
      name: 'Stack Credential',
      username: '',
      password: 'password' in credentialOverrides ? (credentialOverrides.password as string) : '',
      apiToken: 'apiToken' in credentialOverrides ? (credentialOverrides.apiToken as string | null) : 'STACK_JWT',
      certificate: null,
    },
    connectivity: null,
    connectivityProvider: null,
  }
}

describe('Splunk Cloud Roles healthCheck — REST transport', () => {
  it('is healthy when the REST API is reachable and the role exists', async () => {
    const { restore } = captureFetch(() => ({ status: 200, body: { entry: [{ content: {} }] } }))
    try {
      const result = await healthCheck(makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'] } }]))
      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
    } finally {
      restore()
    }
  })
})

describe('Splunk Cloud Roles healthCheck — ACS transport', () => {
  it('fails clearly with no ACS token, without touching the network', async () => {
    const result = await healthCheck(
      makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], transport: 'acs' } }], {
        apiToken: null,
        password: '',
      }),
    )
    expect(result.healthy).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('acs_identity_token')
    expect(result.checks[0].passed).toBe(false)
  })

  it('skips the per-target role check when that target is unreachable, rather than double-failing', async () => {
    const { restore } = captureFetch((url) => {
      if (url.includes('sh-i-bbb')) return { status: 500, body: { code: '500-internal', message: 'boom' } }
      return { status: 200, body: { name: 'soc-analyst' } }
    })
    try {
      const result = await healthCheck(
        makeCtx([
          {
            name: 'sec1',
            fields: {
              name: 'soc-analyst',
              capabilities: ['search'],
              transport: 'acs',
              searchHeadTargets: ['sh-i-aaa', 'sh-i-bbb'],
            },
          },
        ]),
      )
      expect(result.healthy).toBe(false)
      const names = result.checks.map((c) => c.name)
      // One reachability check per target, and only ONE role-existence check
      // (for the reachable target) — the unreachable target's role check is
      // skipped, not reported as a second, redundant failure.
      expect(names.filter((n) => n.startsWith('acs_reachable:'))).toHaveLength(2)
      expect(names.filter((n) => n.startsWith('role:'))).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('is healthy when ACS is reachable and the role exists at its default target', async () => {
    const { restore } = captureFetch(() => ({ status: 200, body: { name: 'soc-analyst' } }))
    try {
      const result = await healthCheck(
        makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], transport: 'acs' } }]),
      )
      expect(result.healthy).toBe(true)
      expect(result.score).toBe(100)
    } finally {
      restore()
    }
  })
})

describe('Splunk Cloud Roles healthCheck — no roles declared', () => {
  it('is trivially healthy with an empty check list', async () => {
    const result = await healthCheck(makeCtx([]))
    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toEqual([])
  })
})
