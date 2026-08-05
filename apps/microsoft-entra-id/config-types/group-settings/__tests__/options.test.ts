import groupSettingOptions from '../options'
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

describe('group-settings options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(groupSettingOptions).toBe(entraOptions)
  })

  it('serves the "groupSettingTemplates" source for the templateId field', async () => {
    mockGraphFetch({
      value: [{ id: '62375ab9-6b52-47ed-826b-58e47e0e304b', displayName: 'Group.Unified', description: 'M365 group settings' }],
    })
    const opts = await groupSettingOptions({
      appId: 'microsoft-entra-id',
      customerId: 'cust-1',
      configTypeId: 'group-settings',
      source: 'groupSettingTemplates',
      component: null,
      settings: { tenant_id: 'tenant-1' },
      credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
    })
    expect(opts).toEqual([
      { value: '62375ab9-6b52-47ed-826b-58e47e0e304b', label: 'Group.Unified', description: 'M365 group settings' },
    ])
  })
})
