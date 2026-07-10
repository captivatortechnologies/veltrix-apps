import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addAccessServer,
  listAccessServers,
  listConnectivityProviders,
  removeAccessServer,
  updateAccessServer,
} from '../access-servers'

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

describe('listAccessServers', () => {
  it('GETs /api/access-servers and normalizes to AccessServer[]', async () => {
    const fetchMock = mockFetch({
      jsonBody: [
        {
          id: 'as1',
          name: 'edge-gw-1',
          endpoint: 'gw1.corp.example.com:443',
          type: 'gateway',
          region: 'us-east-1',
          status: 'active',
          description: 'Primary edge gateway',
          connectivityProviderId: 'p1',
          connectivityProvider: { id: 'p1', name: 'Tailscale Net' },
          // Extra platform fields that must be dropped by normalization:
          customerId: 'cust-1',
        },
      ],
    })

    const servers = await listAccessServers()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/access-servers')
    expect(servers).toEqual([
      {
        id: 'as1',
        name: 'edge-gw-1',
        endpoint: 'gw1.corp.example.com:443',
        type: 'gateway',
        region: 'us-east-1',
        status: 'active',
        description: 'Primary edge gateway',
        connectivityProviderId: 'p1',
        connectivityProvider: { id: 'p1', name: 'Tailscale Net' },
      },
    ])
  })

  it('defaults missing fields to safe empties', async () => {
    mockFetch({ jsonBody: [{ id: 'as2', name: 'gw-2', endpoint: 'gw2:443' }] })
    const [server] = await listAccessServers()
    expect(server).toMatchObject({
      id: 'as2',
      name: 'gw-2',
      endpoint: 'gw2:443',
      region: null,
      description: null,
      connectivityProviderId: null,
      connectivityProvider: null,
    })
  })

  it('throws the platform error message on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 500, textBody: JSON.stringify({ error: 'Failed to fetch access servers' }) })
    await expect(listAccessServers()).rejects.toThrow('Failed to fetch access servers')
  })
})

describe('addAccessServer', () => {
  it('POSTs the input as JSON and returns the created server', async () => {
    const fetchMock = mockFetch({
      status: 201,
      jsonBody: { id: 'as3', name: 'new-gw', endpoint: 'new-gw:443', connectivityProviderId: null },
    })

    const created = await addAccessServer({
      name: 'new-gw',
      endpoint: 'new-gw:443',
      type: 'gateway',
      connectivityProviderId: null,
    })

    expect(created.id).toBe('as3')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/access-servers')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'new-gw',
      endpoint: 'new-gw:443',
      type: 'gateway',
      connectivityProviderId: null,
    })
  })

  it('surfaces raw text when the error body is not JSON', async () => {
    mockFetch({ ok: false, status: 400, textBody: 'Missing required access server fields' })
    await expect(addAccessServer({ name: 'x', endpoint: 'y' })).rejects.toThrow(
      'Missing required access server fields',
    )
  })
})

describe('updateAccessServer', () => {
  it('PUTs to /api/access-servers/:id with the id encoded', async () => {
    const fetchMock = mockFetch({ jsonBody: { id: 'as 4', name: 'gw', endpoint: 'gw:443' } })
    await updateAccessServer('as 4', { name: 'gw', endpoint: 'gw:443' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/access-servers/as%204')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' })
  })
})

describe('removeAccessServer', () => {
  it('DELETEs and treats 204 as success', async () => {
    const fetchMock = mockFetch({ ok: false, status: 204 })
    await expect(removeAccessServer('as5')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/access-servers/as5')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
  })

  it('throws on a real error status', async () => {
    mockFetch({ ok: false, status: 404, textBody: JSON.stringify({ error: 'Access server not found' }) })
    await expect(removeAccessServer('missing')).rejects.toThrow('Access server not found')
  })
})

describe('listConnectivityProviders', () => {
  it('GETs /api/connectivity-providers and normalizes a bare array', async () => {
    const fetchMock = mockFetch({
      jsonBody: [
        { id: 'p1', name: 'Tailscale Net', providerType: 'tailscale', status: 'active', extra: 'drop-me' },
      ],
    })

    const providers = await listConnectivityProviders()

    expect(fetchMock.mock.calls[0][0]).toBe('/api/connectivity-providers')
    expect(providers).toEqual([
      { id: 'p1', name: 'Tailscale Net', providerType: 'tailscale', status: 'active' },
    ])
  })

  it('unwraps a paginated { data } response', async () => {
    mockFetch({
      jsonBody: { data: [{ id: 'p2', name: 'WireGuard VPN' }], pagination: {} },
    })
    const providers = await listConnectivityProviders()
    expect(providers).toEqual([
      { id: 'p2', name: 'WireGuard VPN', providerType: undefined, status: undefined },
    ])
  })

  it('throws on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 500, textBody: 'boom' })
    await expect(listConnectivityProviders()).rejects.toThrow('boom')
  })
})
