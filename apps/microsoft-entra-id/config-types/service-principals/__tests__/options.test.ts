import servicePrincipalOptions from '../options'

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
  configTypeId: 'service-principals',
  source: 'ownerPrincipals',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('service-principals options', () => {
  it('routes "ownerPrincipals" to the merged users+servicePrincipals picker (no groups)', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/users')) return { status: 200, body: { value: [{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] } }
      if (u.includes('/servicePrincipals')) return { status: 200, body: { value: [{ id: 'sp-1', appId: 'app-1', displayName: 'Deploy Bot' }] } }
      return { status: 404, body: {} }
    })
    const opts = await servicePrincipalOptions(baseCtx)
    expect(opts).toEqual([
      { value: 'u-1', label: 'Ada Lovelace (ada@contoso.com) (user)', description: 'ada@contoso.com' },
      { value: 'sp-1', label: 'Deploy Bot (service principal)', description: 'app-1' },
    ])
  })

  it('returns [] for a source neither entraOptions nor this wrapper recognizes', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await servicePrincipalOptions({ ...baseCtx, source: 'not-a-real-source' })
    expect(opts).toEqual([])
  })
})
