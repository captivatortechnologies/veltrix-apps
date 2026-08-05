import cloudflareOptions from '../cloudflareOptions'

// --- Fetch mock ---------------------------------------------------------------

/** Stub globalThis.fetch to return a canned single-page /zones envelope. */
function mockZonesFetch(zones: Array<{ id: string; name: string; status?: string }>): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    const body = JSON.stringify({
      success: true,
      result: zones,
      result_info: { page: 1, total_pages: 1 },
    })
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => body,
    }
  }) as unknown as typeof fetch
  return calls
}

const cred = {
  id: 'c1',
  name: 'Prod account',
  username: 'acct-123',
  password: '',
  apiToken: 'cf-token',
  certificate: null,
}

const baseCtx = {
  appId: 'cloudflare',
  customerId: 'cust-1',
  configTypeId: 'cloudflare-dns-records',
  component: null,
  connectivityProvider: null,
  settings: {} as Record<string, unknown>,
}

describe('cloudflareOptions — zones (Domain picker)', () => {
  it('lists the account zones as domain options', async () => {
    mockZonesFetch([
      { id: 'z1', name: 'acme.com', status: 'active' },
      { id: 'z2', name: 'acme.dev', status: 'pending' },
    ])
    const opts = await cloudflareOptions({ ...baseCtx, source: 'zones', credential: cred })
    expect(opts).toEqual([
      { value: 'acme.com', label: 'acme.com', description: 'active' },
      { value: 'acme.dev', label: 'acme.dev', description: 'pending' },
    ])
  })

  it('scopes the request to the account id from the connection', async () => {
    const calls = mockZonesFetch([{ id: 'z1', name: 'acme.com', status: 'active' }])
    await cloudflareOptions({ ...baseCtx, source: 'zones', credential: cred })
    expect(calls.some((u) => u.includes('account.id=acct-123'))).toBe(true)
  })

  it('filters by the query, case-insensitively', async () => {
    mockZonesFetch([
      { id: 'z1', name: 'acme.com', status: 'active' },
      { id: 'z2', name: 'other.net', status: 'active' },
    ])
    const opts = await cloudflareOptions({ ...baseCtx, source: 'zones', query: 'ACME', credential: cred })
    expect(opts).toEqual([{ value: 'acme.com', label: 'acme.com', description: 'active' }])
  })

  it('returns nothing for an unrelated source', async () => {
    const opts = await cloudflareOptions({ ...baseCtx, source: 'something-else', credential: cred })
    expect(opts).toEqual([])
  })

  it('throws when no credential is present', async () => {
    let threw = false
    try {
      await cloudflareOptions({ ...baseCtx, source: 'zones', credential: null })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})
