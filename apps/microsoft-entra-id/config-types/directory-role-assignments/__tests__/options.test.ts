import directoryRoleAssignmentOptions from '../options'

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
  configTypeId: 'directory-role-assignments',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('directoryRoleAssignmentOptions — routing', () => {
  it('routes "directoryPrincipals" to the merged principal picker', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/users')) return { status: 200, body: { value: [{ id: 'u-1', displayName: 'Ada' }] } }
      return { status: 200, body: { value: [] } }
    })
    const opts = await directoryRoleAssignmentOptions({ ...baseCtx, source: 'directoryPrincipals' })
    expect(opts).toEqual([{ value: 'u-1', label: 'Ada (user)' }])
  })

  it('routes "directoryScope" to the merged scope picker (includes the tenant sentinel)', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await directoryRoleAssignmentOptions({ ...baseCtx, source: 'directoryScope' })
    expect(opts).toEqual([{ value: '/', label: 'Tenant-wide (/)', description: 'Applies across the entire directory' }])
  })

  it('routes "roleDefinitions" straight through to entraOptions', async () => {
    mockGraphFetch((u) =>
      u.includes('roleManagement/directory/roleDefinitions')
        ? { status: 200, body: { value: [{ id: 'r1', displayName: 'Global Administrator', isBuiltIn: true }] } }
        : { status: 404, body: {} }
    )
    const opts = await directoryRoleAssignmentOptions({ ...baseCtx, source: 'roleDefinitions' })
    expect(opts).toEqual([{ value: 'r1', label: 'Global Administrator', description: 'Built-in role' }])
  })

  it('returns [] for a source neither entraOptions nor this wrapper recognizes', async () => {
    const opts = await directoryRoleAssignmentOptions({ ...baseCtx, source: 'not-a-real-source' })
    expect(opts).toEqual([])
  })
})
