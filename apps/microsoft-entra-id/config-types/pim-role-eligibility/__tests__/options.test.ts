import pimRoleEligibilityOptions from '../options'

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
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
}

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'pim-role-eligibility',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('pimRoleEligibilityOptions — routing', () => {
  it('routes "directoryPrincipals" to the merged principal picker', async () => {
    mockGraphFetch((u) => (u.includes('/groups') ? { status: 200, body: { value: [{ id: 'g-1', displayName: 'Eng' }] } } : { status: 200, body: { value: [] } }))
    const opts = await pimRoleEligibilityOptions({ ...baseCtx, source: 'directoryPrincipals' })
    expect(opts).toEqual([{ value: 'g-1', label: 'Eng (group)', description: 'g-1' }])
  })

  it('routes "directoryScope" to the merged scope picker', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await pimRoleEligibilityOptions({ ...baseCtx, source: 'directoryScope' })
    expect(opts).toEqual([{ value: '/', label: 'Tenant-wide (/)', description: 'Applies across the entire directory' }])
  })

  it('routes "roleDefinitions" straight through to entraOptions', async () => {
    mockGraphFetch((u) =>
      u.includes('roleManagement/directory/roleDefinitions')
        ? { status: 200, body: { value: [{ id: 'r1', displayName: 'Global Administrator', isBuiltIn: true }] } }
        : { status: 404, body: {} }
    )
    const opts = await pimRoleEligibilityOptions({ ...baseCtx, source: 'roleDefinitions' })
    expect(opts).toEqual([{ value: 'r1', label: 'Global Administrator', description: 'Built-in role' }])
  })

  it('returns [] for a source neither entraOptions nor this wrapper recognizes', async () => {
    const opts = await pimRoleEligibilityOptions({ ...baseCtx, source: 'not-a-real-source' })
    expect(opts).toEqual([])
  })
})
