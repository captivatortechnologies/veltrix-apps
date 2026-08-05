import { listRefIds, reconcileRefCollection, type RefMemberEntry } from '../refReconcile'
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

const APP_BASE = '/applications/app-1'
const USER_ID = 'u-1'
const SP_ID = 'sp-1'
const OTHER_ID = 'sp-2'

describe('listRefIds', () => {
  it('collects ids from a $ref collection listing', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [{ id: USER_ID }, { id: SP_ID }] } }))
    const result = await listRefIds(client(), APP_BASE, 'owners')
    expect(result.ok).toBe(true)
    expect([...result.ids]).toEqual([USER_ID, SP_ID])
  })
})

describe('reconcileRefCollection', () => {
  it('adds every desired reference not already live, via POST {base}/{refName}/$ref with a directoryObjects @odata.id', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/owners')) return { status: 200, body: { value: [] } }
      if (method === 'POST' && u.includes('/owners/$ref')) return { status: 204, body: {} }
      return { status: 404, body: {} }
    })
    const { members, failures } = await reconcileRefCollection(client(), APP_BASE, 'owners', [USER_ID, SP_ID], [])
    expect(failures).toEqual([])
    expect(members).toEqual([
      { id: USER_ID, existed: false },
      { id: SP_ID, existed: false },
    ])
    const addCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/owners/$ref'))
    expect(addCalls).toHaveLength(2)
    for (const c of addCalls) {
      const odataId = (c.body as { '@odata.id'?: string })['@odata.id'] ?? ''
      expect(odataId).toContain('https://graph.microsoft.com/v1.0/directoryObjects/')
    }
  })

  it('does not re-add a reference that is already live', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/owners')) return { status: 200, body: { value: [{ id: USER_ID }] } }
      return { status: 204, body: {} }
    })
    await reconcileRefCollection(client(), APP_BASE, 'owners', [USER_ID], [])
    const addCalls = calls.filter((c) => c.method === 'POST' && c.url.includes('/owners/$ref'))
    expect(addCalls).toHaveLength(0)
  })

  it('a reference already live but untracked is treated as pre-existing (existed:true)', async () => {
    mockGraphFetch((method, u) => (method === 'GET' && u.includes('/owners') ? { status: 200, body: { value: [{ id: USER_ID }] } } : { status: 204, body: {} }))
    const { members } = await reconcileRefCollection(client(), APP_BASE, 'owners', [USER_ID], [])
    expect(members).toEqual([{ id: USER_ID, existed: true }])
  })

  it('removes ONLY references this app previously added (existed:false) that are no longer declared', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/owners')) return { status: 200, body: { value: [{ id: USER_ID }, { id: SP_ID }, { id: OTHER_ID }] } }
      return { status: 204, body: {} }
    })
    const prior: RefMemberEntry[] = [
      { id: USER_ID, existed: false }, // app-owned, no longer declared -> revoke
      { id: SP_ID, existed: true }, // pre-existing, no longer declared -> leave alone
      { id: OTHER_ID, existed: false }, // app-owned, still declared -> leave alone
    ]
    const { members } = await reconcileRefCollection(client(), APP_BASE, 'owners', [OTHER_ID], prior)

    const deleteCalls = calls.filter((c) => c.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].url).toContain(`/owners/${USER_ID}/$ref`)
    // The critical safety property: the delete call MUST end in "/$ref" — without
    // it Graph deletes the referenced object itself, not just the reference.
    expect(deleteCalls[0].url.endsWith('/$ref')).toBe(true)
    expect(members).toEqual([{ id: OTHER_ID, existed: false }])
  })

  it('leaves the collection unchanged and reports a failure when the live listing cannot be read', async () => {
    mockGraphFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }))
    const prior: RefMemberEntry[] = [{ id: USER_ID, existed: false }]
    const { members, failures } = await reconcileRefCollection(client(), APP_BASE, 'owners', [SP_ID], prior)
    expect(members).toEqual(prior)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('reports a per-reference failure without throwing when an add fails', async () => {
    mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/owners')) return { status: 200, body: { value: [] } }
      if (method === 'POST') return { status: 403, body: { error: { code: 'Forbidden', message: 'no permission' } } }
      return { status: 404, body: {} }
    })
    const { members, failures } = await reconcileRefCollection(client(), APP_BASE, 'owners', [USER_ID], [])
    expect(members).toEqual([])
    expect(failures.some((f) => f.includes('no permission'))).toBe(true)
  })
})
