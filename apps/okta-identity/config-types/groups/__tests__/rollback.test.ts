// =============================================================================
// groups — rollback, driven against the fake Okta org.
//
// Rollback is the undo for a deploy that went wrong on live access grants. A
// group this deploy CREATED is deleted outright; a group it updated is restored
// to the captured prior profile — and its prior static member set, but ONLY when
// that deploy managed membership. Restoring membership nobody asked it to manage
// would revoke access the deploy never touched.
// =============================================================================

import rollback from '../rollback'
import type { GroupRollbackEntry } from '../deploy'
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

function created(overrides: Partial<GroupRollbackEntry> = {}): GroupRollbackEntry {
  return { name: 'Engineering', existed: false, id: '00gNEW', managedMembership: false, ...overrides }
}

function updated(overrides: Partial<GroupRollbackEntry> = {}): GroupRollbackEntry {
  return {
    name: 'Engineering',
    existed: true,
    id: '00gLIVE',
    prior: { name: 'Engineering', description: 'Original description' },
    managedMembership: false,
    ...overrides,
  }
}

describe('groups rollback', () => {
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
      const result = await rollback(
        rollbackContext({ previousState: [created()] }, { hostname: '' }),
      )
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

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([ok({})], async (calls) => {
      const res = await rollback(rollbackContext({ previousState: [created()] }))
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })

  it('deletes a group this deploy created', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('DELETE')
      expect(writes[0].path).toBe('/groups/00gNEW')
    })
  })

  it('treats a 404 on the delete as already gone', async () => {
    await withFetch([notFound()], async () => {
      const result = await rollback(rollbackContext({ previousState: [created()] }))
      expect(result.success).toBe(true)
    })
  })

  it('does nothing for a created entry whose id was never captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [created({ id: undefined })] }))
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('restores the captured prior profile of a group this deploy updated', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [updated()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/groups/00gLIVE')
      expect(writes[0].json.profile).toEqual({
        name: 'Engineering',
        description: 'Original description',
      })
    })
  })

  it('never deletes a group that existed before the deploy', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [updated()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('leaves an updated group alone when no prior profile was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [updated({ prior: undefined })] }),
      )
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('never touches membership when the deploy did not manage it', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated({ managedMembership: false, priorMembers: ['00uOLD'] })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/users'))).toBe(false)
    })
  })

  it('restores the exact prior member set when the deploy managed membership', async () => {
    await withFetch(
      [
        ok({}), // PUT profile restore
        ok([{ id: '00uADDED' }, { id: '00uOLD' }]), // GET current members
        ok({}), // PUT re-add the member the deploy removed
        ok({}), // DELETE the member the deploy added
      ],
      async (calls) => {
        const result = await rollback(
          rollbackContext({
            previousState: [
              updated({ managedMembership: true, priorMembers: ['00uOLD', '00uGONE'] }),
            ],
          }),
        )

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(3)
        expect(writes[1].method).toBe('PUT')
        expect(writes[1].path).toBe('/groups/00gLIVE/users/00uGONE')
        expect(writes[2].method).toBe('DELETE')
        expect(writes[2].path).toBe('/groups/00gLIVE/users/00uADDED')
      },
    )
  })

  it('still re-adds the prior members when the member read 404s', async () => {
    await withFetch([ok({}), notFound(), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [updated({ managedMembership: true, priorMembers: ['00uOLD'] })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path === '/groups/00gLIVE/users/00uOLD' && c.method === 'PUT')).toBe(
        true,
      )
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [updated()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore group "Engineering"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the delete is rejected', async () => {
    const result = await withFetch([apiError('Cannot delete group', 400)], async () =>
      rollback(rollbackContext({ previousState: [created()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to delete group/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ name: 'Sales', id: '00gTWO' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('names every group it reverted so an operator can verify the undo', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      rollback(
        rollbackContext({
          previousState: [created(), created({ name: 'Sales', id: '00gTWO' })],
        }),
      ),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/2 group\(s\)/)
    expect(result.message).toMatch(/Engineering, Sales/)
  })
})
