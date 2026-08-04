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
    configTypeId: 'xsoar-indicator-fields',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-indicator-fields',
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

describe('Cortex XSOAR Indicator Fields Deploy Handler', () => {
  it('creates a new field via GET /incidentfields then POST /incidentfields/import', async () => {
    await withMockFetch(
      [
        { status: 200, body: '[]' },
        { status: 200, body: '{}' },
      ],
      async (calls) => {
        const result = await deploy(
          makeCtx([{ name: 's1', fields: { cliName: 'eventtype', name: 'Event Type', type: 'shortText' } }]),
        )
        expect(result.success).toBe(true)
        expect(calls).toHaveLength(2)
        expect(calls[0].method).toBe('GET')
        expect(calls[0].url).toContain('/incidentfields')
        expect(calls[1].method).toBe('POST')
        expect(calls[1].url).toContain('/incidentfields/import')
        expect(calls[1].isMultipart).toBe(true)
      },
    )
  })

  it('only matches an existing field with the "indicator_" id prefix', async () => {
    await withMockFetch(
      [
        // Same cliName exists as an INCIDENT field — must not be treated as a live indicator field.
        { status: 200, body: JSON.stringify([{ id: 'incident_eventtype', version: 9 }]) },
        { status: 200, body: '{}' },
      ],
      async () => {
        const result = await deploy(
          makeCtx([{ name: 's1', fields: { cliName: 'eventtype', name: 'Event Type', type: 'shortText' } }]),
        )
        expect(result.success).toBe(true)
        expect(result.message).toContain('Deployed 1 indicator field(s)')
      },
    )
  })

  it('refuses to modify a built-in/locked field', async () => {
    await withMockFetch(
      [{ status: 200, body: JSON.stringify([{ id: 'indicator_eventtype', locked: true }]) }],
      async () => {
        const result = await deploy(
          makeCtx([{ name: 's1', fields: { cliName: 'eventtype', name: 'Event Type', type: 'shortText' } }]),
        )
        expect(result.success).toBe(false)
        expect(result.message).toContain('locked')
      },
    )
  })

  it('reports a clear error when no credential is available', async () => {
    const ctx = makeCtx([{ name: 's1', fields: { cliName: 'eventtype', name: 'Event Type', type: 'shortText' } }])
    ctx.credential = null
    const result = await deploy(ctx)
    expect(result.success).toBe(false)
  })
})
