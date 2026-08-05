import authorizationPolicyOptions from '../options'
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

describe('authorization-policy options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(authorizationPolicyOptions).toBe(entraOptions)
  })

  it('serves the "permissionGrantPolicies" source for the permissionGrantPoliciesAssigned field', async () => {
    mockGraphFetch({
      value: [{ id: 'microsoft-user-default-legacy', displayName: 'Default legacy permission grant policy' }],
    })
    const opts = await authorizationPolicyOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'authorization-policy',
      source: 'permissionGrantPolicies',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([
      {
        value: 'microsoft-user-default-legacy',
        label: 'Default legacy permission grant policy',
        description: 'microsoft-user-default-legacy',
      },
    ])
  })
})
