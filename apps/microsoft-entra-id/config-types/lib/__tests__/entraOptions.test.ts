import entraOptions from '../entraOptions'

// --- Fetch mock ----------------------------------------------------------------
// GraphClient makes two calls per request: a token exchange against
// login.microsoftonline.com, then the actual Graph request. Route the first to
// a canned token response and hand the second to the test's responder.

interface FetchCall {
  url: string
  headers: Record<string, string>
}

function mockGraphFetch(responder: (url: string) => { status: number; body: unknown }): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const u = String(url)
    calls.push({ url: u, headers: (init?.headers as Record<string, string>) ?? {} })
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
}

describe('entraOptions — groups (a $search-capable directory object)', () => {
  it('lists live groups, mapping id/displayName to value/label', async () => {
    mockGraphFetch((u) =>
      u.includes('/groups')
        ? { status: 200, body: { value: [{ id: 'g1', displayName: 'Engineering' }] } }
        : { status: 404, body: {} },
    )
    const opts = await entraOptions({ ...baseCtx, source: 'groups', credential: cred })
    expect(opts).toEqual([{ value: 'g1', label: 'Engineering', description: 'g1' }])
  })

  it('sends $search + ConsistencyLevel: eventual when a query is given', async () => {
    const calls = mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    await entraOptions({ ...baseCtx, source: 'groups', query: 'eng', credential: cred })
    const graphCall = calls.find((c) => c.url.includes('/groups'))
    expect(graphCall).toBeDefined()
    expect(graphCall!.url).toContain('$search=')
    expect(graphCall!.url).toContain('displayName')
    expect(graphCall!.headers.ConsistencyLevel).toBe('eventual')
  })

  it('does not send $search (or the eventual header) without a query', async () => {
    const calls = mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    await entraOptions({ ...baseCtx, source: 'groups', credential: cred })
    const graphCall = calls.find((c) => c.url.includes('/groups'))
    expect(graphCall!.url.includes('search')).toBe(false)
    expect(graphCall!.headers.ConsistencyLevel).toBeUndefined()
  })
})

describe('entraOptions — users', () => {
  it('labels a user as "Display Name (upn)"', async () => {
    mockGraphFetch(() => ({
      status: 200,
      body: { value: [{ id: 'u1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] },
    }))
    const opts = await entraOptions({ ...baseCtx, source: 'users', credential: cred })
    expect(opts).toEqual([
      { value: 'u1', label: 'Ada Lovelace (ada@contoso.com)', description: 'ada@contoso.com' },
    ])
  })
})

describe('entraOptions — applications (value=appId, cloud-app sentinels)', () => {
  it('prepends All / Office365 / MicrosoftAdminPortals ahead of live apps', async () => {
    mockGraphFetch(() => ({
      status: 200,
      body: { value: [{ id: 'obj-1', appId: 'app-1', displayName: 'Contoso Portal' }] },
    }))
    const opts = await entraOptions({ ...baseCtx, source: 'applications', credential: cred })
    expect(opts[0]).toEqual({
      value: 'All',
      label: 'All cloud apps (All)',
      description: 'Every cloud app registered in the tenant',
    })
    expect(opts.some((o) => o.value === 'Office365')).toBe(true)
    expect(opts.some((o) => o.value === 'MicrosoftAdminPortals')).toBe(true)
    // value is the appId, not the object id — CA's includeApplications stores appIds.
    expect(opts.some((o) => o.value === 'app-1' && o.label === 'Contoso Portal' && o.description === 'obj-1')).toBe(
      true,
    )
  })

  it('never offers a "None" sentinel — not a documented Graph value for this field', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await entraOptions({ ...baseCtx, source: 'applications', credential: cred })
    expect(opts.some((o) => o.value === 'None')).toBe(false)
  })

  it('filters the sentinels by query alongside the live apps', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await entraOptions({ ...baseCtx, source: 'applications', query: 'office', credential: cred })
    expect(opts).toEqual([
      {
        value: 'Office365',
        label: 'Office 365 (Office365)',
        description: 'The Microsoft 365 app suite (Exchange, SharePoint, Teams, ...)',
      },
    ])
  })
})

describe('entraOptions — servicePrincipals (value=object id, no sentinels)', () => {
  it('uses the object id as the value and the appId as the description', async () => {
    mockGraphFetch(() => ({
      status: 200,
      body: { value: [{ id: 'sp-1', appId: 'app-1', displayName: 'Contoso Enterprise App' }] },
    }))
    const opts = await entraOptions({ ...baseCtx, source: 'servicePrincipals', credential: cred })
    expect(opts).toEqual([{ value: 'sp-1', label: 'Contoso Enterprise App', description: 'app-1' }])
  })
})

describe('entraOptions — namedLocations (not a $search-capable resource)', () => {
  it('labels each location by its named-location kind', async () => {
    mockGraphFetch(() => ({
      status: 200,
      body: {
        value: [
          { '@odata.type': '#microsoft.graph.ipNamedLocation', id: 'n1', displayName: 'Corp IPs' },
          { '@odata.type': '#microsoft.graph.countryNamedLocation', id: 'n2', displayName: 'US Only' },
        ],
      },
    }))
    const opts = await entraOptions({ ...baseCtx, source: 'namedLocations', credential: cred })
    expect(opts).toEqual([
      { value: 'n1', label: 'Corp IPs', description: 'IP range' },
      { value: 'n2', label: 'US Only', description: 'Country/region' },
    ])
  })

  it('filters on the label in memory instead of sending $search', async () => {
    const calls = mockGraphFetch(() => ({
      status: 200,
      body: {
        value: [
          { '@odata.type': '#microsoft.graph.ipNamedLocation', id: 'n1', displayName: 'Corp IPs' },
          { '@odata.type': '#microsoft.graph.countryNamedLocation', id: 'n2', displayName: 'US Only' },
        ],
      },
    }))
    const opts = await entraOptions({ ...baseCtx, source: 'namedLocations', query: 'corp', credential: cred })
    expect(opts).toEqual([{ value: 'n1', label: 'Corp IPs', description: 'IP range' }])
    const graphCall = calls.find((c) => c.url.includes('namedLocations'))
    expect(graphCall!.url.includes('search')).toBe(false)
  })
})

describe('entraOptions — misc', () => {
  it('returns [] for a source it does not know', async () => {
    const opts = await entraOptions({ ...baseCtx, source: 'not-a-real-source', credential: cred })
    expect(opts).toEqual([])
  })

  it('throws a clear message when there is no usable credential', async () => {
    let threw = false
    try {
      await entraOptions({ ...baseCtx, source: 'groups', credential: null })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('throws with the Graph error message on a failed request', async () => {
    mockGraphFetch(() => ({
      status: 403,
      body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } },
    }))
    let message = ''
    try {
      await entraOptions({ ...baseCtx, source: 'groups', credential: cred })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('Insufficient privileges')
  })
})
