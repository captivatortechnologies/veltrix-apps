import deploy from '../deploy'
import { buildCreateBody, buildUserOperations } from '../deploy'
import type { DeployContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): DeployContext {
  return {
    appId: 'onepassword',
    customerId: 'cust-1',
    configTypeId: 'users',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'onepassword',
      entityType: 'users',
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
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
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

const listResponse = (resources: unknown[]) =>
  JSON.stringify({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: resources.length,
    Resources: resources,
  })

describe('1Password Users Deploy Handler', () => {
  it('creates a user that does not yet exist on the bridge', async () => {
    await withMockFetch(
      [
        { status: 200, body: listResponse([]) },
        { status: 201, body: JSON.stringify({ id: 'u-123', userName: 'ada@example.com' }) },
      ],
      async (calls) => {
        const ctx = makeCtx([{ name: 'User', fields: { userName: 'ada@example.com', givenName: 'Ada', active: true } }])
        const result = await deploy(ctx)
        expect(result.success).toBe(true)

        const createCall = calls.find((c) => c.method === 'POST' && c.url.endsWith('/Users'))
        expect(createCall).toBeDefined()
        const body = createCall!.body as Record<string, unknown>
        expect(body.userName).toBe('ada@example.com')
        expect(body.active).toBe(true)
        expect((body.name as Record<string, unknown>).givenName).toBe('Ada')

        const rollbackData = result.rollbackData as { previousState: Array<{ existed: boolean; id?: string }> }
        expect(rollbackData.previousState[0].existed).toBe(false)
        expect(rollbackData.previousState[0].id).toBe('u-123')
      },
    )
  })

  it('patches an existing user, always converging active and only sending declared name fields', async () => {
    await withMockFetch(
      [
        {
          status: 200,
          body: listResponse([{ id: 'u-1', userName: 'ada@example.com', active: true, name: { givenName: 'Old', familyName: 'Name' } }]),
        },
        { status: 200, body: '' },
      ],
      async (calls) => {
        const ctx = makeCtx([{ name: 'User', fields: { userName: 'ada@example.com', givenName: 'Ada', active: false } }])
        const result = await deploy(ctx)
        expect(result.success).toBe(true)

        const patchCall = calls.find((c) => c.method === 'PATCH')
        expect(patchCall).toBeDefined()
        expect(patchCall!.url).toContain('/Users/u-1')
        const ops = (patchCall!.body as { Operations: Array<{ path: string; value: unknown }> }).Operations
        expect(ops.find((o) => o.path === 'active')?.value).toBe(false)
        expect(ops.find((o) => o.path === 'name.givenName')?.value).toBe('Ada')
        // familyName was left blank on the canvas, so no operation for it.
        expect(ops.find((o) => o.path === 'name.familyName')).toBeUndefined()

        const rollbackData = result.rollbackData as { previousState: Array<{ existed: boolean; prior?: { active: boolean } }> }
        expect(rollbackData.previousState[0].existed).toBe(true)
        expect(rollbackData.previousState[0].prior?.active).toBe(true)
      },
    )
  })

  it('reports failure clearly and stops without throwing when the bridge rejects a create', async () => {
    await withMockFetch(
      [
        { status: 200, body: listResponse([]) },
        { status: 400, body: JSON.stringify({ detail: 'userName already in use' }) },
      ],
      async () => {
        const ctx = makeCtx([{ name: 'User', fields: { userName: 'ada@example.com' } }])
        const result = await deploy(ctx)
        expect(result.success).toBe(false)
        expect(result.message).toContain('userName already in use')
      },
    )
  })
})

describe('buildCreateBody', () => {
  it('omits the name object entirely when no name fields are declared', () => {
    const body = buildCreateBody({ sectionName: 's', userName: 'a@b.com', givenName: '', familyName: '', active: true })
    expect(body.name).toBeUndefined()
    expect(body.schemas).toEqual(['urn:ietf:params:scim:schemas:core:2.0:User'])
    expect(body.emails).toEqual([{ value: 'a@b.com', primary: true }])
  })
})

describe('buildUserOperations', () => {
  it('always includes active but only includes populated name fields', () => {
    const ops = buildUserOperations({ sectionName: 's', userName: 'a@b.com', givenName: '', familyName: 'Lovelace', active: true })
    expect(ops).toEqual([
      { op: 'replace', path: 'active', value: true },
      { op: 'replace', path: 'name.familyName', value: 'Lovelace' },
    ])
  })
})
