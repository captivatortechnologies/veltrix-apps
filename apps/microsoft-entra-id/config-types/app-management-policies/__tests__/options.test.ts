import appManagementPolicyOptions from '../options'

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
  configTypeId: 'app-management-policies',
  source: 'applicationOrServicePrincipal',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('app-management-policies options', () => {
  it('routes "applicationOrServicePrincipal" to the merged applicationObjects+servicePrincipals picker', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/applications')) return { status: 200, body: { value: [{ id: 'app-obj-1', appId: 'client-1', displayName: 'API App' }] } }
      if (u.includes('/servicePrincipals')) return { status: 200, body: { value: [{ id: 'sp-1', appId: 'client-2', displayName: 'Deploy Bot' }] } }
      return { status: 404, body: {} }
    })
    const opts = await appManagementPolicyOptions(baseCtx)
    expect(opts).toEqual([
      { value: 'app-obj-1', label: 'API App (application)', description: 'client-1' },
      { value: 'sp-1', label: 'Deploy Bot (service principal)', description: 'client-2' },
    ])
  })

  it('returns [] for a source neither entraOptions nor this wrapper recognizes', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await appManagementPolicyOptions({ ...baseCtx, source: 'not-a-real-source' })
    expect(opts).toEqual([])
  })
})
