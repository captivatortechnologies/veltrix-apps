import administrativeUnitOptions from '../options'

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
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
}

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'administrative-units',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('administrativeUnitOptions', () => {
  it('merges users + groups + devices for "administrativeUnitMembers", labelling each option by kind', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/users')) return { status: 200, body: { value: [{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] } }
      if (u.includes('/groups')) return { status: 200, body: { value: [{ id: 'g-1', displayName: 'Engineering' }] } }
      if (u.includes('/devices')) return { status: 200, body: { value: [{ id: 'd-1', displayName: "Ada's Laptop" }] } }
      return { status: 404, body: {} }
    })
    const opts = await administrativeUnitOptions({ ...baseCtx, source: 'administrativeUnitMembers' })
    expect(opts).toEqual([
      { value: 'u-1', label: 'Ada Lovelace (ada@contoso.com) (user)', description: 'ada@contoso.com' },
      { value: 'g-1', label: 'Engineering (group)', description: 'g-1' },
      { value: 'd-1', label: "Ada's Laptop (device)", description: 'd-1' },
    ])
  })

  it('routes any other source straight through to entraOptions', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await administrativeUnitOptions({ ...baseCtx, source: 'not-a-real-source' })
    expect(opts).toEqual([])
  })
})
