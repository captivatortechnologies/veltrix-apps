import deploy from '../deploy'
import type { DeployContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): DeployContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-mappers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-mappers',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
    component: { id: 'comp-1', hostname: 'xsoar.example.com', port: '443', type: ['xsoar-server'], toolId: 'cortex-xsoar' },
    credential: { id: 'cred-1', name: 'XSOAR', username: '', password: '', apiToken: 'test-api-key', certificate: null },
    connectivity: null,
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  }
}

interface MockCall {
  url: string
  method: string
  isMultipart: boolean
}

/** Swap in a canned `fetch` for the duration of `run`, recording every call, and always restore the original. */
async function withMockFetch(
  responses: Array<{ status: number; body: string }>,
  run: (calls: MockCall[]) => Promise<void>,
): Promise<void> {
  const calls: MockCall[] = []
  const original = global.fetch
  let index = 0
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      isMultipart: typeof FormData !== 'undefined' && init?.body instanceof FormData,
    })
    const next = responses[Math.min(index, responses.length - 1)]
    index++
    return { status: next.status, text: async () => next.body } as Response
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    global.fetch = original
  }
}

describe('Cortex XSOAR Mappers Deploy Handler', () => {
  it('creates a new incoming mapper via POST /classifier/search then POST /classifier/import', async () => {
    await withMockFetch(
      [
        { status: 200, body: '[]' },
        { status: 200, body: '{}' },
      ],
      async (calls) => {
        const result = await deploy(
          makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme Incoming', direction: 'incoming' } }]),
        )
        expect(result.success).toBe(true)
        expect(calls).toHaveLength(2)
        expect(calls[0].method).toBe('POST')
        expect(calls[0].url).toContain('/classifier/search')
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toContain('/classifier/import')
        expect(calls[1].isMultipart).toBe(true)
      },
    )
  })

  it('only matches an existing object typed as a mapper, not a classifier with the same id', async () => {
    await withMockFetch(
      [
        { status: 200, body: JSON.stringify([{ id: 'AcmeIn', type: 'classification', version: 2 }]) },
        { status: 200, body: '{}' },
      ],
      async () => {
        const result = await deploy(
          makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme Incoming', direction: 'incoming' } }]),
        )
        expect(result.success).toBe(true)
        expect(result.message).toContain('Deployed 1 mapper(s)')
      },
    )
  })

  it('refuses to modify a built-in/locked mapper', async () => {
    await withMockFetch(
      [{ status: 200, body: JSON.stringify([{ id: 'AcmeIn', type: 'mapping-incoming', locked: true }]) }],
      async () => {
        const result = await deploy(
          makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme Incoming', direction: 'incoming' } }]),
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain('locked')
      },
    )
  })

  it('reports a clear error when no credential is available', async () => {
    const ctx = makeCtx([{ name: 's1', fields: { id: 'AcmeIn', name: 'Acme Incoming', direction: 'incoming' } }])
    ctx.credential = null
    const result = await deploy(ctx)
    expect(result.success).toBe(false)
  })
})
