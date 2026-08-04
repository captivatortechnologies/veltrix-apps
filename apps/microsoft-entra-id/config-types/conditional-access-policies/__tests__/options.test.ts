import conditionalAccessOptions from '../options'

// --- Fetch mock ----------------------------------------------------------------
// Same harness as config-types/lib/__tests__/entraOptions.test.ts: GraphClient
// makes a token exchange then the real Graph request; route the token call to a
// canned response and hand the Graph call to the test's responder.

interface FetchCall {
  url: string
}

function mockGraphFetch(responder: (url: string) => { status: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    calls.push({ url: u })
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
  return calls
}

const cred = { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null }

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'conditional-access-policies',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: cred,
}

describe('conditionalAccessOptions — usersInclude / usersExclude sentinel asymmetry', () => {
  it('prepends All/None/GuestsOrExternalUsers ahead of the live users list for usersInclude', async () => {
    mockGraphFetch((u) =>
      u.includes('/users')
        ? { status: 200, body: { value: [{ id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] } }
        : { status: 404, body: {} }
    )
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'usersInclude' })
    expect(opts.map((o) => o.value)).toEqual(['All', 'None', 'GuestsOrExternalUsers', 'u1'])
  })

  it('offers ONLY GuestsOrExternalUsers ahead of the live users list for usersExclude', async () => {
    mockGraphFetch((u) => (u.includes('/users') ? { status: 200, body: { value: [] } } : { status: 404, body: {} }))
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'usersExclude' })
    expect(opts.map((o) => o.value)).toEqual(['GuestsOrExternalUsers'])
  })

  it('routes both aliases to the same underlying "users" Graph collection', async () => {
    const calls = mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    await conditionalAccessOptions({ ...baseCtx, source: 'usersInclude' })
    await conditionalAccessOptions({ ...baseCtx, source: 'usersExclude' })
    const userCalls = calls.filter((c) => c.url.includes('/users'))
    expect(userCalls.length).toBe(2)
  })

  it('filters the sentinels by query alongside the live users', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'usersInclude', query: 'guest' })
    expect(opts).toEqual([
      {
        value: 'GuestsOrExternalUsers',
        label: 'Guests or external users (GuestsOrExternalUsers)',
        description: 'Every guest and external user type',
      },
    ])
  })
})

describe('conditionalAccessOptions — namedLocationsInclude / namedLocations sentinel asymmetry', () => {
  it('prepends All/AllTrusted ahead of the live named-locations list for namedLocationsInclude', async () => {
    mockGraphFetch((u) =>
      u.includes('namedLocations')
        ? { status: 200, body: { value: [{ '@odata.type': '#microsoft.graph.ipNamedLocation', id: 'n1', displayName: 'Corp IPs' }] } }
        : { status: 404, body: {} }
    )
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'namedLocationsInclude' })
    expect(opts.map((o) => o.value)).toEqual(['All', 'AllTrusted', 'n1'])
  })

  it('offers NO sentinel for the plain "namedLocations" source (excludeLocations)', async () => {
    mockGraphFetch((u) =>
      u.includes('namedLocations')
        ? { status: 200, body: { value: [{ '@odata.type': '#microsoft.graph.ipNamedLocation', id: 'n1', displayName: 'Corp IPs' }] } }
        : { status: 404, body: {} }
    )
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'namedLocations' })
    expect(opts.map((o) => o.value)).toEqual(['n1'])
  })
})

describe('conditionalAccessOptions — sources with no CA-specific behavior', () => {
  it('passes roleDefinitions straight through with no sentinel', async () => {
    mockGraphFetch((u) =>
      u.includes('roleManagement/directory/roleDefinitions')
        ? { status: 200, body: { value: [{ id: 'r1', displayName: 'Global Administrator', isBuiltIn: true }] } }
        : { status: 404, body: {} }
    )
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'roleDefinitions' })
    expect(opts).toEqual([{ value: 'r1', label: 'Global Administrator', description: 'Built-in role' }])
  })

  it('passes authStrengthPolicies straight through with no sentinel', async () => {
    mockGraphFetch((u) =>
      u.includes('authenticationStrengthPolicies')
        ? { status: 200, body: { value: [{ id: 's1', displayName: 'Phishing-resistant MFA' }] } }
        : { status: 404, body: {} }
    )
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'authStrengthPolicies' })
    expect(opts).toEqual([{ value: 's1', label: 'Phishing-resistant MFA' }])
  })

  it('passes termsOfUse straight through with no sentinel', async () => {
    mockGraphFetch((u) =>
      u.includes('termsOfUse/agreements')
        ? { status: 200, body: { value: [{ id: 't1', displayName: 'Contoso ToU' }] } }
        : { status: 404, body: {} }
    )
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'termsOfUse' })
    // entraOptions' termsOfUse source surfaces the id as the description too (opt(t.id, t.displayName, t.id)).
    expect(opts).toEqual([{ value: 't1', label: 'Contoso ToU', description: 't1' }])
  })

  it('returns [] for a source neither entraOptions nor this wrapper recognizes', async () => {
    const opts = await conditionalAccessOptions({ ...baseCtx, source: 'not-a-real-source' })
    expect(opts).toEqual([])
  })
})
