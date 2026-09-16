// =============================================================================
// linked-objects — rollback, driven against the fake Okta org.
//
// Deleting a linked-object definition removes EVERY user link that used it, and
// there is no way to put those links back. So rollback may only ever delete a
// definition this deploy created; a definition that already existed (which deploy
// left untouched) must never be deleted by the undo.
// =============================================================================

import rollback from '../rollback'
import type { LinkedObjectRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  rollbackContext,
  withFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeOkta'

function created(
  overrides: Partial<LinkedObjectRollbackEntry> = {},
): LinkedObjectRollbackEntry {
  return { primaryName: 'manager', existed: false, ...overrides }
}

describe('linked-objects rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }, { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back rather than guessing', async () => {
    for (const data of [undefined, {}, { previousState: [] }, { previousState: undefined }]) {
      await withFetch([], async (calls) => {
        const result = await rollback(rollbackContext(data))
        expect(result.success).toBe(false)
        expect(result.message).toBe('No previous state available for rollback')
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('deletes a definition this deploy created', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/meta/schemas/user/linkedObjects/manager')
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/removing every user link that used them/)
    expect(leaksToken(result)).toBe(false)
  })

  it('escapes a relationship name so it can never break out of the path', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(
        rollbackContext({ previousState: [created({ primaryName: 'man ager/../users' })] }),
      )

      expect(calls[0].path).toBe('/meta/schemas/user/linkedObjects/man%20ager%2F..%2Fusers')
    })
  })

  it('never deletes a definition that existed before the deploy', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created({ existed: true })] }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
      expect(result.message).toMatch(/1 linked-object definition\(s\)/)
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete linked-object definition "manager"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ primaryName: 'mentor' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('names every definition it reverted so an operator can verify the undo', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(
        rollbackContext({ previousState: [created(), created({ primaryName: 'mentor' })] }),
      ),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/manager, mentor/)
  })
})
