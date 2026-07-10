import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCredential,
  listCredentials,
  removeCredential,
  updateCredential,
} from '../credentials'

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

describe('listCredentials', () => {
  it('GETs /api/tools/:toolId/credentials and REDACTS secrets', async () => {
    const fetchMock = mockFetch({
      jsonBody: [
        {
          id: 'c1',
          name: 'idx1.splunk.internal',
          username: 'svc_veltrix',
          type: 'password',
          toolId: 'tool-1',
          // Secret material that MUST NOT survive redaction:
          password: 'super-secret',
          apiToken: 'tok-abc',
          certificate: 'cert-pem',
        },
      ],
    })

    const creds = await listCredentials('tool-1')

    expect(fetchMock.mock.calls[0][0]).toBe('/api/tools/tool-1/credentials')
    // Summary carries no secret fields, only `hasSecret`.
    expect(creds).toEqual([
      { id: 'c1', name: 'idx1.splunk.internal', username: 'svc_veltrix', type: 'password', toolId: 'tool-1', hasSecret: true },
    ])
    const serialized = JSON.stringify(creds)
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('tok-abc')
    expect(serialized).not.toContain('cert-pem')
  })

  it('reports hasSecret=false when no password or apiToken is stored', async () => {
    mockFetch({ jsonBody: [{ id: 'c2', name: 'n', username: 'u', toolId: 't', password: '', apiToken: null }] })
    const [cred] = await listCredentials('t')
    expect(cred).toMatchObject({ id: 'c2', type: null, hasSecret: false })
  })

  it('encodes the toolId in the path', async () => {
    const fetchMock = mockFetch({ jsonBody: [] })
    await listCredentials('tool 1/2')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tools/tool%201%2F2/credentials')
  })

  it('unwraps a paginated { data } response', async () => {
    mockFetch({ jsonBody: { data: [{ id: 'c3', name: 'n', username: 'u', toolId: 't' }], pagination: {} } })
    const creds = await listCredentials('t')
    expect(creds).toEqual([{ id: 'c3', name: 'n', username: 'u', type: null, toolId: 't', hasSecret: false }])
  })

  it('throws the platform error message on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 500, textBody: JSON.stringify({ error: 'Failed to fetch credentials' }) })
    await expect(listCredentials('t')).rejects.toThrow('Failed to fetch credentials')
  })
})

describe('createCredential', () => {
  it('POSTs the input as JSON, defaulting tagIds to [] and password to ""', async () => {
    const fetchMock = mockFetch({ status: 201, jsonBody: { id: 'c4' } })

    const created = await createCredential({
      name: 'idx1',
      username: 'svc',
      password: '',
      apiToken: 'hec-token',
      type: 'token',
      toolId: 'tool-1',
    })

    expect(created).toEqual({ id: 'c4' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/credentials')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'idx1',
      username: 'svc',
      password: '',
      apiToken: 'hec-token',
      type: 'token',
      toolId: 'tool-1',
      tagIds: [],
    })
  })

  it('surfaces raw text when the error body is not JSON', async () => {
    mockFetch({ ok: false, status: 400, textBody: 'Missing required credential fields' })
    await expect(createCredential({ name: 'x', username: 'y', password: 'z', toolId: 't' })).rejects.toThrow(
      'Missing required credential fields',
    )
  })
})

describe('updateCredential', () => {
  it('PUTs only the provided fields, omitting untouched secrets', async () => {
    const fetchMock = mockFetch({ jsonBody: { id: 'c5' } })
    await updateCredential('c5', { username: 'new-user' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/credentials/c5')
    expect(init).toMatchObject({ method: 'PUT' })
    // password / apiToken were not passed, so they are absent from the body.
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ username: 'new-user' })
  })

  it('encodes the id in the path', async () => {
    const fetchMock = mockFetch({ jsonBody: {} })
    await updateCredential('c 6', { apiToken: 'rotated' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/credentials/c%206')
  })
})

describe('removeCredential', () => {
  it('DELETEs and treats 204 as success', async () => {
    const fetchMock = mockFetch({ ok: false, status: 204 })
    await expect(removeCredential('c7')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/credentials/c7')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
  })

  it('throws on a real error status', async () => {
    mockFetch({ ok: false, status: 404, textBody: JSON.stringify({ error: 'Credential not found' }) })
    await expect(removeCredential('missing')).rejects.toThrow('Credential not found')
  })
})
