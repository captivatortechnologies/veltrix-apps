import assignmentPolicyOptions from '../options'
import entraOptions from '../../lib/entraOptions'

describe('entitlement-assignment-policies options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(assignmentPolicyOptions).toBe(entraOptions)
  })

  it('serves the "accessPackages" source', async () => {
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
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ value: [{ id: 'ap-1', displayName: 'Sales reps', description: null }] }),
      }
    }) as unknown as typeof fetch

    const opts = await assignmentPolicyOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'entitlement-assignment-policies',
      source: 'accessPackages',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([{ value: 'ap-1', label: 'Sales reps', description: 'ap-1' }])
  })
})
