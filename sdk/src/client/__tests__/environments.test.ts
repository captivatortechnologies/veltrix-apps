import { afterEach, describe, expect, it, vi } from 'vitest'
import { listEnvironments } from '../environments'

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

describe('listEnvironments', () => {
  it('GETs /api/environments and normalizes to {id, name}', async () => {
    const fetchMock = mockFetch({
      jsonBody: [
        { id: 'env-1', name: 'Production', extra: 'drop-me' },
        { id: 'env-2', name: 'Staging' },
      ],
    })
    const envs = await listEnvironments()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/environments')
    expect(envs).toEqual([
      { id: 'env-1', name: 'Production' },
      { id: 'env-2', name: 'Staging' },
    ])
  })

  it('unwraps a paginated { data } response and defaults a missing name', async () => {
    mockFetch({ jsonBody: { data: [{ id: 'env-3' }], pagination: {} } })
    expect(await listEnvironments()).toEqual([{ id: 'env-3', name: '' }])
  })

  it('throws the platform error message on a non-2xx response', async () => {
    mockFetch({ ok: false, status: 500, textBody: JSON.stringify({ error: 'Failed to fetch environments' }) })
    await expect(listEnvironments()).rejects.toThrow('Failed to fetch environments')
  })
})
