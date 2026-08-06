import deploy from '../deploy'
import { resolveMemberIds } from '../deploy'
import type { DeployContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): DeployContext {
  return {
    appId: 'onepassword',
    customerId: 'cust-1',
    configTypeId: 'groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onepassword',
      entityType: 'groups',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
    component: { id: 'comp-1', hostname: 'scim.example.com', port: '443', type: ['onepassword-scim-bridge'], toolId: 'onepassword' },
    credential: { id: 'cred-1', name: '1Password', username: '', password: '', apiToken: 'test-bearer-token', certificate: null },
    connectivity: null,
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  }
}

interface MockCall {
  url: string
  method: string
  body: unknown
}

async function withMockFetch(
  responder: (url: string, method: string) => { status: number; body: string },
  run: (calls: MockCall[]) => Promise<void>,
): Promise<void> {
  const calls: MockCall[] = []
  const original = global.fetch
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const next = responder(url, method)
    return { status: next.status, text: async () => next.body } as Response
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    global.fetch = original
  }
}

const listResponse = (resources: unknown[]) =>
  JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: resources.length, Resources: resources })

describe('1Password Groups Deploy Handler', () => {
  it('creates a missing group and sets its resolved members', async () => {
    await withMockFetch(
      (url, method) => {
        if (method === 'GET' && url.includes('/Groups')) return { status: 200, body: listResponse([]) }
        if (method === 'GET' && url.includes('/Users')) {
          return { status: 200, body: listResponse([{ id: 'u-1', userName: 'ada@example.com' }]) }
        }
        if (method === 'POST' && url.endsWith('/Groups')) return { status: 201, body: JSON.stringify({ id: 'g-1', displayName: 'Engineering' }) }
        return { status: 200, body: '' } // PATCH members
      },
      async (calls) => {
        const ctx = makeCtx([{ name: 'Group', fields: { displayName: 'Engineering', memberUserNames: ['ada@example.com'] } }])
        const result = await deploy(ctx)
        expect(result.success).toBe(true)

        const patchCall = calls.find((c) => c.method === 'PATCH')
        expect(patchCall!.url).toContain('/Groups/g-1')
        const ops = (patchCall!.body as { Operations: Array<{ path: string; value: unknown }> }).Operations
        expect(ops[0].path).toBe('members')
        expect(ops[0].value).toEqual([{ value: 'u-1' }])
      },
    )
  })

  it('full-replaces membership on an existing group, including clearing it to empty', async () => {
    await withMockFetch(
      (url, method) => {
        if (method === 'GET' && url.includes('/Groups')) {
          return { status: 200, body: listResponse([{ id: 'g-1', displayName: 'Engineering', members: [{ value: 'u-1' }] }]) }
        }
        if (method === 'GET' && url.includes('/Users')) return { status: 200, body: listResponse([{ id: 'u-1', userName: 'ada@example.com' }]) }
        return { status: 200, body: '' }
      },
      async (calls) => {
        const ctx = makeCtx([{ name: 'Group', fields: { displayName: 'Engineering', memberUserNames: [] } }])
        const result = await deploy(ctx)
        expect(result.success).toBe(true)

        const patchCall = calls.find((c) => c.method === 'PATCH')
        const ops = (patchCall!.body as { Operations: Array<{ path: string; value: unknown }> }).Operations
        expect(ops[0].value).toEqual([])

        const rollbackData = result.rollbackData as { previousState: Array<{ existed: boolean; priorMemberIds?: string[] }> }
        expect(rollbackData.previousState[0].existed).toBe(true)
        expect(rollbackData.previousState[0].priorMemberIds).toEqual(['u-1'])
      },
    )
  })

  it('fails clearly when a declared member email does not exist on the bridge', async () => {
    await withMockFetch(
      (url, method) => {
        if (method === 'GET' && url.includes('/Groups')) return { status: 200, body: listResponse([]) }
        if (method === 'GET' && url.includes('/Users')) return { status: 200, body: listResponse([]) }
        return { status: 200, body: '' }
      },
      async () => {
        const ctx = makeCtx([{ name: 'Group', fields: { displayName: 'Engineering', memberUserNames: ['ghost@example.com'] } }])
        const result = await deploy(ctx)
        expect(result.success).toBe(false)
        expect(result.message).toContain('ghost@example.com')
      },
    )
  })
})

describe('resolveMemberIds', () => {
  it('resolves declared emails to ids case-insensitively', () => {
    const ids = resolveMemberIds(
      { sectionName: 's', displayName: 'Engineering', memberUserNames: ['Ada@Example.com'] },
      new Map([['ada@example.com', 'u-1']]),
    )
    expect(ids).toEqual(['u-1'])
  })

  it('throws listing every unresolved email', () => {
    let thrown: unknown
    try {
      resolveMemberIds({ sectionName: 's', displayName: 'Engineering', memberUserNames: ['a@b.com', 'c@d.com'] }, new Map())
    } catch (e) {
      thrown = e
    }
    expect(thrown instanceof Error).toBe(true)
    expect((thrown as Error).message).toContain('a@b.com, c@d.com')
  })
})
