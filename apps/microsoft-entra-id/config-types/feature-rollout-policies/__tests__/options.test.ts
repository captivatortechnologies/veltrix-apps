import featureRolloutPolicyOptions from '../options'
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

describe('feature-rollout-policies options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(featureRolloutPolicyOptions).toBe(entraOptions)
  })

  it('serves the "groups" source for the appliesTo field (groups only)', async () => {
    mockGraphFetch({ value: [{ id: 'g-1', displayName: 'Pilot Ring' }] })
    const opts = await featureRolloutPolicyOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'feature-rollout-policies',
      source: 'groups',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([{ value: 'g-1', label: 'Pilot Ring', description: 'g-1' }])
  })
})
