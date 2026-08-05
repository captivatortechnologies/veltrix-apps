import oauth2PermissionGrantOptions from '../options'
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

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'oauth2-permission-grants',
  source: 'servicePrincipals',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('oauth2-permission-grants options', () => {
  it('is a direct re-export of the shared entraOptions provider', () => {
    expect(oauth2PermissionGrantOptions).toBe(entraOptions)
  })

  it('serves the "servicePrincipals" source for clientId/resourceId', async () => {
    mockGraphFetch({ value: [{ id: 'sp-1', appId: 'app-1', displayName: 'API' }] })
    const opts = await oauth2PermissionGrantOptions(baseCtx)
    expect(opts).toEqual([{ value: 'sp-1', label: 'API', description: 'app-1' }])
  })

  it('serves the "users" source for principalId', async () => {
    mockGraphFetch({ value: [{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] })
    const opts = await oauth2PermissionGrantOptions({ ...baseCtx, source: 'users' })
    expect(opts).toEqual([{ value: 'u-1', label: 'Ada Lovelace (ada@contoso.com)', description: 'ada@contoso.com' }])
  })
})
