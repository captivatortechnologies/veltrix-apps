import { reconcileMembers, buildCreateBody, buildPatchBody } from '../deploy'
import { buildGraphClient } from '../../../lib/graph'

interface Call {
  method: string
  url: string
  body?: unknown
}

function mockGraphFetch(responder: (method: string, url: string) => { status: number; body: unknown }): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
      }
    }
    calls.push({ method, url: u, body: init?.body ? JSON.parse(init.body) : undefined })
    const { status, body } = responder(method, u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
  return calls
}

function client() {
  return buildGraphClient(
    { tenantId: 'tenant-1', clientId: 'client-id', clientSecret: 'secret' },
    { timeoutMs: 5000, tenantId: 'tenant-1' }
  )
}

const UNIT_ID = 'au-1'
const USER_ID = 'u-1'
const GROUP_ID = 'g-1'
const DEVICE_ID = 'd-1'

describe('reconcileMembers', () => {
  it('adds every desired member not already live, via POST .../members/$ref with a directoryObjects @odata.id', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [] } }
      if (method === 'POST' && u.includes('/members/$ref')) return { status: 204, body: {} }
      return { status: 404, body: {} }
    })
    const { members, failures } = await reconcileMembers(client(), UNIT_ID, [USER_ID, GROUP_ID], [])
    expect(failures).toEqual([])
    expect(members).toEqual([
      { id: USER_ID, existed: false },
      { id: GROUP_ID, existed: false },
    ])
    const addCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/members/$ref'))
    expect(addCalls).toHaveLength(2)
    for (const c of addCalls) {
      const odataId = (c.body as { '@odata.id'?: string })['@odata.id'] ?? ''
      expect(odataId).toContain('https://graph.microsoft.com/v1.0/directoryObjects/')
    }
  })

  it('does not re-add a member that is already live', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [{ id: USER_ID }] } }
      return { status: 204, body: {} }
    })
    await reconcileMembers(client(), UNIT_ID, [USER_ID], [])
    const addCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/members/$ref'))
    expect(addCalls).toHaveLength(0)
  })

  it('a member already live but untracked is treated as pre-existing (existed:true), not owned by this app', async () => {
    mockGraphFetch((method, u) => (method === 'GET' && u.includes('/members') ? { status: 200, body: { value: [{ id: USER_ID }] } } : { status: 204, body: {} }))
    const { members } = await reconcileMembers(client(), UNIT_ID, [USER_ID], [])
    expect(members).toEqual([{ id: USER_ID, existed: true }])
  })

  it('removes ONLY members this app previously added (existed:false) that are no longer declared', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [{ id: USER_ID }, { id: GROUP_ID }, { id: DEVICE_ID }] } }
      return { status: 204, body: {} }
    })
    const prior = [
      { id: USER_ID, existed: false }, // app-owned, no longer declared -> revoke
      { id: GROUP_ID, existed: true }, // pre-existing, no longer declared -> leave alone
      { id: DEVICE_ID, existed: false }, // app-owned, still declared -> leave alone
    ]
    const { members } = await reconcileMembers(client(), UNIT_ID, [DEVICE_ID], prior)

    const deleteCalls = calls.filter((c) => c.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].url).toContain(`/members/${USER_ID}/$ref`)
    // The critical safety property: the delete call MUST end in "/$ref" — without
    // it Graph deletes the member object itself, not just the membership.
    expect(deleteCalls[0].url.endsWith('/$ref')).toBe(true)
    expect(members).toEqual([{ id: DEVICE_ID, existed: false }])
  })

  it('leaves membership unchanged and reports a failure when the live listing cannot be read', async () => {
    mockGraphFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }))
    const prior = [{ id: USER_ID, existed: false }]
    const { members, failures } = await reconcileMembers(client(), UNIT_ID, [GROUP_ID], prior)
    expect(members).toEqual(prior)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('reports a per-member failure without throwing when an add fails', async () => {
    mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/members')) return { status: 200, body: { value: [] } }
      if (method === 'POST') return { status: 403, body: { error: { code: 'Forbidden', message: 'no permission' } } }
      return { status: 404, body: {} }
    })
    const { members, failures } = await reconcileMembers(client(), UNIT_ID, [USER_ID], [])
    expect(members).toEqual([])
    expect(failures.some((f) => f.includes('no permission'))).toBe(true)
  })
})

describe('buildCreateBody / buildPatchBody are unaffected by members (a separate reconcile step)', () => {
  it('never includes a members key', () => {
    const spec = { name: 'AU', description: '', visibility: 'public', members: ['x'] }
    expect('members' in buildCreateBody(spec)).toBeFalsy()
    expect('members' in buildPatchBody(spec)).toBeFalsy()
  })
})
