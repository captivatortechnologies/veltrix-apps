import b2xUserFlowOptions from '../options'
import entraOptions from '../../lib/entraOptions'

function mockGraphFetch(responder: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
      }
    }
    const { status, body } = responder(u)
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
}

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'b2x-user-flows',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('b2x-user-flows options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(b2xUserFlowOptions).toBe(entraOptions)
  })

  it('serves the "identityProviders" source (opaque string ids, not GUIDs)', async () => {
    mockGraphFetch((u) =>
      u.includes('/identity/identityProviders')
        ? { status: 200, body: { value: [{ id: 'Facebook-OAUTH', displayName: 'Facebook', identityProviderType: 'Facebook' }] } }
        : { status: 404, body: {} }
    )
    const opts = await b2xUserFlowOptions({ ...baseCtx, source: 'identityProviders' })
    expect(opts).toEqual([{ value: 'Facebook-OAUTH', label: 'Facebook', description: 'Facebook' }])
  })

  it('serves the "userFlowAttributes" source', async () => {
    mockGraphFetch((u) =>
      u.includes('/identity/userFlowAttributes')
        ? { status: 200, body: { value: [{ id: 'city', displayName: 'City', dataType: 'string', userFlowAttributeType: 'builtIn' }] } }
        : { status: 404, body: {} }
    )
    const opts = await b2xUserFlowOptions({ ...baseCtx, source: 'userFlowAttributes' })
    expect(opts).toEqual([{ value: 'city', label: 'City', description: 'builtIn · string' }])
  })
})
