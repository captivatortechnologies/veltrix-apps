import pimRoleManagementPolicyOptions from '../options'
import entraOptions from '../../lib/entraOptions'

describe('pim-role-management-policies options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(pimRoleManagementPolicyOptions).toBe(entraOptions)
  })

  it('serves the "roleDefinitions" source', async () => {
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
        text: async () => JSON.stringify({ value: [{ id: 'r1', displayName: 'Global Administrator', isBuiltIn: true }] }),
      }
    }) as unknown as typeof fetch

    const opts = await pimRoleManagementPolicyOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'pim-role-management-policies',
      source: 'roleDefinitions',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([{ value: 'r1', label: 'Global Administrator', description: 'Built-in role' }])
  })
})
