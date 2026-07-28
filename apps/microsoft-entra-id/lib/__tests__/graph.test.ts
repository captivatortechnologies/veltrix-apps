import { buildGraphClient } from '../graph'

type Page = { status: number; ok: boolean; body: string; nextUrl: string | null }
type Gettable = { get: (path: string) => Promise<Page> }

/** A GraphClient whose paginated GET is stubbed to yield `pages` pages total. */
function stubbedClient(pages: number) {
  const client = buildGraphClient(
    { tenantId: 't', clientId: 'c', clientSecret: 's' },
    { timeoutMs: 1000, tenantId: 't' },
  )
  let call = 0
  ;(client as unknown as Gettable).get = async () => {
    call++
    const hasNext = call < pages
    return {
      status: 200,
      ok: true,
      body: JSON.stringify({ value: [{ id: `item-${call}` }], '@odata.nextLink': hasNext ? 'https://next' : undefined }),
      nextUrl: hasNext ? 'https://next' : null,
    }
  }
  return client
}

describe('GraphClient.getAll pagination + truncation', () => {
  it('fetches every page and reports truncated:false when the collection ends within budget', async () => {
    const res = await stubbedClient(3).getAll('/applications', 10)
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(false)
    expect(res.items).toHaveLength(3)
  })

  it('stops at maxPages and reports truncated:true when more pages remain', async () => {
    const res = await stubbedClient(50).getAll('/applications', 5)
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true) // a nextLink was still pending at the cap
    expect(res.items).toHaveLength(5)
  })

  it('reports truncated:false when the last page exactly hits the cap', async () => {
    const res = await stubbedClient(5).getAll('/applications', 5)
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(false) // page 5 had no nextLink
    expect(res.items).toHaveLength(5)
  })

  it('propagates a failed page as ok:false (never a false truncation)', async () => {
    const client = buildGraphClient(
      { tenantId: 't', clientId: 'c', clientSecret: 's' },
      { timeoutMs: 1000, tenantId: 't' },
    )
    ;(client as unknown as Gettable).get = async () => ({ status: 500, ok: false, body: 'boom', nextUrl: null })
    const res = await client.getAll('/applications', 5)
    expect(res.ok).toBe(false)
    expect(res.truncated).toBe(false)
  })
})
