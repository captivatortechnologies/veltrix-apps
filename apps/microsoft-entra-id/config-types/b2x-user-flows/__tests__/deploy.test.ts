import { reconcileAttributeAssignments, buildAttributeMaps } from '../deploy'
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

const FLOW_ID = 'B2X_1_Partner'
const CITY_ID = 'city'
const DOB_ID = 'extension_guid_dob'

describe('buildAttributeMaps', () => {
  it('builds id/name/metadata maps from GET /identity/userFlowAttributes', async () => {
    mockGraphFetch((method, u) =>
      method === 'GET' && u.includes('/identity/userFlowAttributes')
        ? { status: 200, body: { value: [{ id: CITY_ID, displayName: 'City', dataType: 'string' }] } }
        : { status: 404, body: {} }
    )
    const maps = await buildAttributeMaps(client())
    expect(maps.idsLower.get('city')).toBe(CITY_ID)
    expect(maps.nameToId.get('city')).toBe(CITY_ID)
    expect(maps.metaById.get(CITY_ID)).toEqual({ displayName: 'City', dataType: 'string' })
  })
})

describe('reconcileAttributeAssignments', () => {
  it('adds every desired attribute not already live, via POST userAttributeAssignments with a full body', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/userAttributeAssignments')) return { status: 200, body: { value: [] } }
      if (method === 'POST' && u.includes('/userAttributeAssignments')) return { status: 201, body: { id: CITY_ID } }
      return { status: 404, body: {} }
    })
    const { entries, failures } = await reconcileAttributeAssignments(
      client(),
      FLOW_ID,
      [{ id: CITY_ID, meta: { displayName: 'City', dataType: 'string' } }],
      []
    )
    expect(failures).toEqual([])
    expect(entries).toEqual([{ id: CITY_ID, existed: false }])
    const postCalls = calls.filter((c) => c.method === 'POST')
    expect(postCalls).toHaveLength(1)
    expect(postCalls[0].body).toEqual({
      isOptional: false,
      requiresVerification: false,
      userInputType: 'textBox',
      displayName: 'City',
      userAttributeValues: [],
      userAttribute: { id: CITY_ID },
    })
  })

  it('defaults a dateTime attribute to userInputType "dateTimeDropdown"', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/userAttributeAssignments')) return { status: 200, body: { value: [] } }
      return { status: 201, body: { id: DOB_ID } }
    })
    await reconcileAttributeAssignments(client(), FLOW_ID, [{ id: DOB_ID, meta: { displayName: 'Date of birth', dataType: 'dateTime' } }], [])
    const postCalls = calls.filter((c) => c.method === 'POST')
    expect((postCalls[0].body as { userInputType: string }).userInputType).toBe('dateTimeDropdown')
  })

  it('does not re-add an attribute that is already live', async () => {
    const calls = mockGraphFetch((method, u) =>
      method === 'GET' && u.includes('/userAttributeAssignments') ? { status: 200, body: { value: [{ id: CITY_ID }] } } : { status: 204, body: {} }
    )
    await reconcileAttributeAssignments(client(), FLOW_ID, [{ id: CITY_ID, meta: { displayName: 'City' } }], [])
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('removes ONLY attributes this app previously added (existed:false) that are no longer declared, via a real DELETE (not $ref)', async () => {
    const calls = mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/userAttributeAssignments')) return { status: 200, body: { value: [{ id: CITY_ID }, { id: DOB_ID }] } }
      return { status: 204, body: {} }
    })
    const prior = [
      { id: CITY_ID, existed: false }, // app-owned, no longer declared -> revoke
      { id: DOB_ID, existed: true }, // pre-existing, no longer declared -> leave alone
    ]
    const { entries } = await reconcileAttributeAssignments(client(), FLOW_ID, [], prior)
    const deleteCalls = calls.filter((c) => c.method === 'DELETE')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].url.endsWith(`/userAttributeAssignments/${CITY_ID}`)).toBe(true)
    expect(entries).toEqual([])
  })

  it('leaves assignments unchanged and reports a failure when the live listing cannot be read', async () => {
    mockGraphFetch(() => ({ status: 500, body: { error: { message: 'boom' } } }))
    const prior = [{ id: CITY_ID, existed: false }]
    const { entries, failures } = await reconcileAttributeAssignments(client(), FLOW_ID, [{ id: DOB_ID, meta: { displayName: 'DOB' } }], prior)
    expect(entries).toEqual(prior)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('reports a per-attribute failure without throwing when an add fails', async () => {
    mockGraphFetch((method, u) => {
      if (method === 'GET' && u.includes('/userAttributeAssignments')) return { status: 200, body: { value: [] } }
      if (method === 'POST') return { status: 403, body: { error: { code: 'Forbidden', message: 'no permission' } } }
      return { status: 404, body: {} }
    })
    const { entries, failures } = await reconcileAttributeAssignments(client(), FLOW_ID, [{ id: CITY_ID, meta: { displayName: 'City' } }], [])
    expect(entries).toEqual([])
    expect(failures.some((f) => f.includes('no permission'))).toBe(true)
  })
})
