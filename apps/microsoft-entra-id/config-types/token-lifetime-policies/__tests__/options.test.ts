import tokenLifetimePolicyOptions from '../options'
import entraOptions from '../../lib/entraOptions'

function mockGraphFetch(body: unknown): void {
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
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }
  }) as unknown as typeof fetch
}

describe('token-lifetime-policies options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(tokenLifetimePolicyOptions).toBe(entraOptions)
  })

  it('serves the "servicePrincipals" source for the appliesTo field', async () => {
    mockGraphFetch({ value: [{ id: 'sp-1', appId: 'app-1', displayName: 'Deploy Bot' }] })
    const opts = await tokenLifetimePolicyOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'token-lifetime-policies',
      source: 'servicePrincipals',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([{ value: 'sp-1', label: 'Deploy Bot', description: 'app-1' }])
  })
})
