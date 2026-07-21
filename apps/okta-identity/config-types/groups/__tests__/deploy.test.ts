import { getCurrentMemberIds } from '../deploy'
import type { OktaClient } from '../../../lib/okta'

/**
 * A member-read 404 must NOT throw — it signals a stale/unresolvable group id so
 * the deploy can skip membership for just that group instead of failing the whole
 * batch (the "Failed to list members … Resource not found (UserGroup)" case).
 */
function mockClient(status: number, body: unknown): OktaClient {
  return {
    request: async () => ({
      status,
      ok: status >= 200 && status < 300,
      body: JSON.stringify(body),
      nextUrl: null,
    }),
  } as unknown as OktaClient
}

describe('getCurrentMemberIds', () => {
  it('returns null on a 404 (group not found) instead of throwing', async () => {
    const result = await getCurrentMemberIds(mockClient(404, { errorSummary: 'Not found' }), '00gStale')
    expect(result).toBeNull()
  })

  it('returns the member ids on 200', async () => {
    const result = await getCurrentMemberIds(
      mockClient(200, [{ id: '00u1' }, { id: '00u2' }, { id: '' }, {}]),
      '00gLive',
    )
    expect(result).toEqual(['00u1', '00u2'])
  })

  it('throws on a non-404 error (real failure)', async () => {
    let message = ''
    try {
      await getCurrentMemberIds(mockClient(500, { errorSummary: 'boom' }), '00gLive')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('Failed to list members')
  })
})
