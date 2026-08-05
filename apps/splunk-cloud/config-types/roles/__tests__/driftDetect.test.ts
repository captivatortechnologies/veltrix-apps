import driftDetect from '../driftDetect'
import type { CanvasItemSnapshot, DriftContext } from '@veltrixsecops/app-sdk'

function captureFetch(handler: (url: string) => { status: number; body: unknown }): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    const { status, body } = handler(String(url))
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

function makeCtx(items: CanvasItemSnapshot[]): DriftContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: { id: 'c', canvasId: 'canvas-1', version: 1, name: 'n', toolType: 'splunk-cloud', entityType: 'roles', items: [], sections: [], snapshot: {} },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'acme', port: '8089', type: ['splunk-cloud-stack'], toolId: 'splunk-cloud' },
    credential: { id: 'cred-1', name: 'Stack Credential', username: '', password: '', apiToken: 'STACK_JWT', certificate: null },
    connectivity: null,
    connectivityProvider: null,
    deployedConfig: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Deployed',
      toolType: 'splunk-cloud',
      entityType: 'roles',
      items,
      sections: items,
      snapshot: {},
    },
  }
}

describe('Splunk Cloud Roles driftDetect — REST transport', () => {
  it('reports no drift when live capabilities match the deployed spec', async () => {
    const { restore } = captureFetch(() => ({
      status: 200,
      body: { entry: [{ content: { capabilities: ['search'] } }] },
    }))
    try {
      const result = await driftDetect(makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'] } }]))
      expect(result.hasDrift).toBe(false)
    } finally {
      restore()
    }
  })

  it('reports critical drift when live capabilities differ', async () => {
    const { restore } = captureFetch(() => ({
      status: 200,
      body: { entry: [{ content: { capabilities: ['search', 'admin_all_objects'] } }] },
    }))
    try {
      const result = await driftDetect(makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'] } }]))
      expect(result.hasDrift).toBe(true)
      expect(result.diffs.some((d) => d.field === 'soc-analyst.capabilities' && d.severity === 'critical')).toBe(true)
    } finally {
      restore()
    }
  })
})

describe('Splunk Cloud Roles driftDetect — ACS transport', () => {
  it('reads imported roles from the nested `imported.roles` object, not a top-level field', async () => {
    const { restore } = captureFetch(() => ({
      status: 200,
      body: { name: 'soc-analyst', capabilities: ['search'], imported: { roles: ['user'] } },
    }))
    try {
      const result = await driftDetect(
        makeCtx([
          { name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], importedRoles: ['user'], transport: 'acs' } },
        ]),
      )
      expect(result.hasDrift).toBe(false)
    } finally {
      restore()
    }
  })

  it('flags drift on ONLY the search-head target that disagrees', async () => {
    const { restore } = captureFetch((url) => {
      if (url.includes('sh-i-bbb')) {
        return { status: 200, body: { name: 'soc-analyst', capabilities: ['search', 'admin_all_objects'] } }
      }
      return { status: 200, body: { name: 'soc-analyst', capabilities: ['search'] } }
    })
    try {
      const result = await driftDetect(
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
      expect(result.hasDrift).toBe(true)
      expect(result.diffs.some((d) => d.field.includes('sh-i-bbb'))).toBe(true)
      expect(result.diffs.some((d) => d.field.includes('sh-i-aaa'))).toBe(false)
    } finally {
      restore()
    }
  })

  it('reports a missing role as critical', async () => {
    const { restore } = captureFetch(() => ({ status: 404, body: { code: '404-role-not-found', message: 'not found' } }))
    try {
      const result = await driftDetect(
        makeCtx([{ name: 'sec1', fields: { name: 'ghost-role', capabilities: ['search'], transport: 'acs' } }]),
      )
      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0]).toEqual({ field: 'ghost-role', expected: 'exists', actual: 'missing', severity: 'critical' })
    } finally {
      restore()
    }
  })
})
