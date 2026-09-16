// =============================================================================
// app-group-assignments — rollback, driven against the fake Okta org.
//
// Unassigning is how a whole group loses an application, so rollback must only
// ever delete an assignment THIS deploy created; one that existed before is PUT
// back to its captured prior priority/profile and never removed.
// =============================================================================

import rollback from '../rollback'
import type { AppGroupAssignmentRollbackEntry } from '../deploy'
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
  overrides: Partial<AppGroupAssignmentRollbackEntry> = {},
): AppGroupAssignmentRollbackEntry {
  return { appId: '0oaAPP', groupId: '00gENG', existed: false, ...overrides }
}

function updated(
  overrides: Partial<AppGroupAssignmentRollbackEntry> = {},
): AppGroupAssignmentRollbackEntry {
  return {
    appId: '0oaAPP',
    groupId: '00gENG',
    existed: true,
    prior: { priority: 5, profile: { role: 'user' } },
    ...overrides,
  }
}

describe('app-group-assignments rollback', () => {
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

  it('unassigns an assignment this deploy created', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/apps/0oaAPP/groups/00gENG')
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a 404 on the unassign as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('restores the captured prior body and never unassigns a pre-existing grant', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/apps/0oaAPP/groups/00gENG')
      expect(writes[0].json).toEqual({ priority: 5, profile: { role: 'user' } })
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('restores an empty prior body as a plain bind rather than skipping the entry', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ prior: undefined })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({})
    })
  })

  it('reverts in reverse order so later changes are undone first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [created(), created({ groupId: '00gSALES' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/apps/0oaAPP/groups/00gSALES')
      expect(calls[1].path).toBe('/apps/0oaAPP/groups/00gENG')
    })
  })

  it('returns a FAILED result rather than throwing when the unassign is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to unassign "0oaAPP:00gENG"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Api validation failed', 400)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore assignment/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ groupId: '00gSALES' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('names every assignment it reverted so an operator can verify the undo', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(
        rollbackContext({ previousState: [created(), created({ groupId: '00gSALES' })] }),
      ),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/0oaAPP:00gSALES, 0oaAPP:00gENG/)
  })
})
