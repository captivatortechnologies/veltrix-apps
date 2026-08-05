import tokenIssuancePolicyOptions from '../options'
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

describe('token-issuance-policies options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(tokenIssuancePolicyOptions).toBe(entraOptions)
  })

  it('serves the "applicationObjects" source (object id) for the appliesTo field', async () => {
    mockGraphFetch({ value: [{ id: 'app-obj-1', appId: 'client-1', displayName: 'API App' }] })
    const opts = await tokenIssuancePolicyOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'token-issuance-policies',
      source: 'applicationObjects',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([{ value: 'app-obj-1', label: 'API App', description: 'client-1' }])
  })
})
