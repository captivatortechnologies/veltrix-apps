import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addInventoryItem,
  listInventory,
  removeInventoryItem,
  resolveTool,
  updateInventoryItem,
} from '../inventory'

// Outside the platform, authFetch falls back to global fetch (no host runtime
// installed), so mocking globalThis.fetch exercises the helpers end to end.
function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  })) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listInventory', () => {
  it('GETs /api/components and normalizes to InventoryItem[]', async () => {
    const fetchMock = mockFetch({
      jsonBody: [
        {
          id: 'c1',
          hostname: 'host-1',
          port: '8089',
          webPort: '8000',
          sshUser: 'root',
          type: ['server'],
          domains: ['corp.example.com'],
          ipRanges: ['10.0.0.0/24'],
          tags: [{ id: 't1', name: 'prod', customerId: 'cust-1' }],
          connectivityProviderId: 'p1',
          // Extra platform fields that must be dropped by normalization:
          toolId: 'tool-1',
          customerId: 'cust-1',
        },
      ],
    })

    const items = await listInventory()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/components')
    expect(items).toEqual([
      {
        id: 'c1',
        hostname: 'host-1',
        port: '8089',
        webPort: '8000',
        sshUser: 'root',
        type: ['server'],
        domains: ['corp.example.com'],
        ipRanges: ['10.0.0.0/24'],
        tags: [{ id: 't1', name: 'prod' }],
        connectivityProviderId: 'p1',
        credentialId: null,
      },
    ])
  })

  it('defaults missing enrichment fields to safe empties', async () => {
    mockFetch({ jsonBody: [{ id: 'c2', hostname: 'host-2' }] })
    const [item] = await listInventory()
    expect(item).toMatchObject({
      id: 'c2',
      hostname: 'host-2',
      webPort: null,
      sshUser: null,
      domains: [],
      ipRanges: [],
      tags: [],
      connectivityProviderId: null,
    })
  })

  it('throws the platform error message on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 500, textBody: JSON.stringify({ error: 'Failed to fetch components' }) })
    await expect(listInventory()).rejects.toThrow('Failed to fetch components')
  })
})

describe('addInventoryItem', () => {
  it('POSTs the input as JSON and returns the created item', async () => {
    const fetchMock = mockFetch({
      status: 201,
      jsonBody: { id: 'c3', hostname: 'new-host', port: '9000', domains: [], ipRanges: [] },
    })

    const created = await addInventoryItem({ hostname: 'new-host', port: '9000', toolId: 'tool-1' })

    expect(created.id).toBe('c3')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/components')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      hostname: 'new-host',
      port: '9000',
      toolId: 'tool-1',
    })
  })

  it('surfaces raw text when the error body is not JSON', async () => {
    mockFetch({ ok: false, status: 400, textBody: 'Missing required component fields' })
    await expect(addInventoryItem({ hostname: 'x' })).rejects.toThrow('Missing required component fields')
  })
})

describe('updateInventoryItem', () => {
  it('PUTs to /api/components/:id with the id encoded', async () => {
    const fetchMock = mockFetch({ jsonBody: { id: 'c 4', hostname: 'h' } })
    await updateInventoryItem('c 4', { hostname: 'h' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/components/c%204')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
  })
})

describe('removeInventoryItem', () => {
  it('DELETEs and treats 204 as success', async () => {
    const fetchMock = mockFetch({ ok: false, status: 204 })
    await expect(removeInventoryItem('c5')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/components/c5')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
  })

  it('throws on a real error status', async () => {
    mockFetch({ ok: false, status: 404, textBody: JSON.stringify({ error: 'Component not found' }) })
    await expect(removeInventoryItem('missing')).rejects.toThrow('Component not found')
  })
})

describe('resolveTool', () => {
  it('resolves a tool by name from a paginated { data } response', async () => {
    const fetchMock = mockFetch({
      jsonBody: { data: [{ id: 'tool-1', name: 'Splunk Enterprise', vendor: 'Veltrix' }], pagination: {} },
    })
    const tool = await resolveTool('Splunk Enterprise')
    // MUST filter server-side by name (not fetch a bare first page): the URL carries
    // the encoded search + a large limit so a tool on a later page is never missed.
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/tools?')
    expect(url).toContain('search=Splunk%20Enterprise')
    expect(url).toContain('limit=100')
    expect(tool).toEqual({ id: 'tool-1', name: 'Splunk Enterprise', vendor: 'Veltrix' })
  })

  it('resolves a tool from a bare array response', async () => {
    mockFetch({ jsonBody: [{ id: 'tool-2', name: 'CrowdStrike Falcon' }] })
    expect(await resolveTool('CrowdStrike Falcon')).toEqual({ id: 'tool-2', name: 'CrowdStrike Falcon' })
  })

  it('returns null when no tool matches the name', async () => {
    mockFetch({ jsonBody: { data: [{ id: 'tool-1', name: 'Splunk Enterprise' }] } })
    expect(await resolveTool('Nope')).toBeNull()
  })

  it('throws on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 500, textBody: 'boom' })
    await expect(resolveTool('x')).rejects.toThrow('boom')
  })
})
